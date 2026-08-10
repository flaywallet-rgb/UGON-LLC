require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const PLISIO_API_KEY = process.env.PLISIO_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// 1. Fetch Wallet & Generate Permanent Address if missing
app.post('/api/wallet/address', async (req, res) => {
    try {
        const { userId, currency } = req.body;
        if (!userId || !currency) return res.status(400).json({ error: 'Missing parameters' });

        // Get user wallet
        let { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', userId).single();
        
        // Create wallet if first time
        if (!wallet) {
            const { data: newWallet } = await supabase.from('wallets').insert([{ user_id: userId }]).select().single();
            wallet = newWallet;
        }

        const addressField = currency === 'USDT_BSC' ? 'usdt_address' : 'bnb_address';

        // Return existing address if already generated
        if (wallet[addressField]) {
            return res.json({ success: true, address: wallet[addressField] });
        }

        // Generate a new permanent address via Plisio Invoice (with 10-year expiry)
        const callbackUrl = `${req.protocol}://${req.get('host')}/api/deposit/webhook`;
        const plisioResponse = await axios.get(`https://api.plisio.net/api/v1/invoices/new`, {
            params: {
                api_key: PLISIO_API_KEY,
                currency: currency,
                source_currency: 'USD',
                source_amount: 0.01, // Minimal trigger amount, ignored by webhook logic
                expire_min: 5256000, // 10 years expiration for permanent use
                order_name: `Permanent_${currency}_${userId}`,
                order_number: `DEP_${userId}_${currency}`,
                callback_url: callbackUrl
            }
        });

        if (plisioResponse.data.status === 'success') {
            const txn = plisioResponse.data.data;
            const permanentAddress = txn.wallet_hash;

            // Save permanent address to database
            await supabase.from('wallets').update({ [addressField]: permanentAddress }).eq('user_id', userId);

            res.json({ success: true, address: permanentAddress });
        } else {
            res.status(400).json({ success: false, error: 'Gateway address generation failed' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// 2. Fetch User Balances
app.get('/api/wallet/balance/:userId', async (req, res) => {
    try {
        const { data: wallet } = await supabase.from('wallets').select('usdt_balance, bnb_balance').eq('user_id', req.params.userId).single();
        res.json({ success: true, wallet: wallet || { usdt_balance: 0, bnb_balance: 0 } });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// 3. Webhook: Automatically match any amount sent to the permanent address
app.all('/api/deposit/webhook', async (req, res) => {
    try {
        const data = req.method === 'POST' ? req.body : req.query;
        const { txn_id, status, currency, order_number, value } = data;

        if (!txn_id || !order_number) return res.status(400).send('Invalid webhook');

        // Check if transaction is already processed to prevent duplicate credits
        const { data: existingTxn } = await supabase.from('transactions').select('txn_id').eq('txn_id', txn_id).single();
        if (existingTxn) return res.status(200).send('Already processed');

        // Process completed or mismatch (mismatch happens when they send any random amount)
        if (status === 'completed' || status === 'mismatch') {
            const receivedAmount = parseFloat(value || 0);
            const userId = order_number.split('_')[1]; // Extract userId from order_number (DEP_userId_currency)

            if (userId && receivedAmount > 0) {
                // Instantly credit exact received amount
                await supabase.rpc('increment_balance', { p_user_id: userId, p_currency: currency, p_amount: receivedAmount });
                
                // Record transaction
                await supabase.from('transactions').insert([{
                    txn_id: txn_id, user_id: userId, type: 'DEPOSIT', currency: currency, amount: receivedAmount, status: 'completed'
                }]);
            }
        }
        res.status(200).send('OK');
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(500).send('Server Error');
    }
});

// 4. Automated Withdrawal
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, currency, amount, destinationAddress } = req.body;
        
        const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', userId).single();
        if (!wallet) return res.status(404).json({ success: false, error: 'Wallet not found' });
        
        const balanceField = currency === 'USDT_BSC' ? 'usdt_balance' : 'bnb_balance';
        if (wallet[balanceField] < amount) return res.status(400).json({ success: false, error: 'Insufficient balance' });

        const payout = await axios.get(`https://api.plisio.net/api/v1/operations/withdraw`, {
            params: { api_key: PLISIO_API_KEY, currency: currency, amount: amount, to: destinationAddress }
        });

        if (payout.data.status === 'success') {
            const txnData = payout.data.data;
            await supabase.rpc('increment_balance', { p_user_id: userId, p_currency: currency, p_amount: -Math.abs(amount) });
            
            await supabase.from('transactions').insert([{
                txn_id: txnData.txn_id || `WTH-${Date.now()}`, user_id: userId, type: 'WITHDRAWAL', currency: currency, amount: amount, status: 'completed'
            }]);

            res.json({ success: true, txn_id: txnData.txn_id });
        } else {
            res.status(400).json({ success: false, error: payout.data.data?.message || 'Withdrawal failed' });
        }
    } catch (err) { res.status(500).json({ success: false, error: 'Server error' }); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
