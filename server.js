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

// 1. Get or Create User Balance
app.get('/api/wallet/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        let { data, error } = await supabase
            .from('wallets')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (error || !data) {
            // Initialize wallet if not exists
            const { data: newWallet, stvarError } = await supabase
                .from('wallets')
                .insert([{ user_id: userId, usdt_balance: 0, bnb_balance: 0 }])
                .select()
                .single();
            if (stvarError) throw stvarError;
            data = newWallet;
        }

        res.json({ success: true, wallet: data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Generate Deposit Address & QR Code via Plisio (Supports any amount >= $0.01)
app.post('/api/deposit/create', async (req, res) => {
    try {
        const { userId, currency, amount } = req.body; // currency: USDT_BSC or BNB
        if (!userId || !currency || !amount || amount < 0.01) {
            return res.status(400).json({ success: false, error: 'Invalid parameters or amount below $0.01 minimum.' });
        }

        const callbackUrl = `${req.protocol}://${req.get('host')}/api/deposit/webhook`;
        
        const plisioResponse = await axios.get(`https://api.plisio.net/api/v1/operations/new`, {
            params: {
                api_key: PLISIO_API_KEY,
                currency: currency,
                source_currency: 'USD',
                source_amount: amount,
                order_name: `Deposit for ${userId}`,
                order_number: `DEP-${Date.now()}-${userId}`,
                callback_url: callbackUrl
            }
        });

        if (plisioResponse.data.status === 'success') {
            const txn = plisioResponse.data.result;
            
            // Log pending transaction
            await supabase.from('transactions').insert([{
                user_id: userId,
                type: 'DEPOSIT',
                currency: currency,
                amount: txn.source_amount || amount,
                txn_id: txn.txn_id,
                status: 'pending'
            }]);

            res.json({ success: true, payment: txn });
        } else {
            res.status(400).json({ success: false, error: plisioResponse.data.message || 'Failed to create Plisio invoice' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.response?.data || err.message });
    }
});

// 3. Plisio Instant Webhook Handler (Handles exact/mismatch micro-amounts automatically)
app.all('/api/deposit/webhook', async (req, res) => {
    try {
        const data = req.method === 'POST' ? req.body : req.query;
        const { txn_id, status, psaldo, currency, order_number, source_amount, value } = data;

        if (!txn_id) return res.status(400).send('Invalid webhook data');

        // Check if transaction was already processed
        const { data: existingTxn } = await supabase
            .from('transactions')
            .select('*')
            .eq('txn_id', txn_id)
            .single();

        if (existingTxn && existingTxn.status === 'completed') {
            return res.status(200).send('Already processed');
        }

        // Accept 'completed' or 'mismatch' (if funds are received successfully)
        if (status === 'completed' || status === 'mismatch') {
            const creditAmount = parseFloat(value || source_amount || 0);
            const userId = order_number ? order_number.split('-').slice(2).join('-') : null;

            if (userId && creditAmount > 0) {
                // Call atomic increment function in Supabase
                await supabase.rpc('increment_balance', {
                    p_user_id: userId,
                    p_currency: currency,
                    p_amount: creditAmount
                });

                // Update transaction status
                await supabase.from('transactions').upsert({
                    user_id: userId,
                    type: 'DEPOSIT',
                    currency: currency,
                    amount: creditAmount,
                    txn_id: txn_id,
                    status: 'completed'
                }, { onConflict: 'txn_id' });
            }
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(500).send('Server Error');
    }
});

// 4. Automated Withdrawal System
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, currency, amount, destinationAddress } = req.body;
        if (!userId || !currency || !amount || !destinationAddress || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid withdrawal details.' });
        }

        // Check user balance
        const { data: wallet, error } = await supabase
            .from('wallets')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (error || !wallet) return res.status(404).json({ success: false, error: 'Wallet not found.' });

        const balanceField = currency === 'USDT_BSC' ? 'usdt_balance' : 'bnb_balance';
        if (wallet[balanceField] < amount) {
            return res.status(400).json({ success: false, error: 'Insufficient balance.' });
        }

        // Execute Plisio Payout/Withdrawal API
        const payoutResponse = await axios.get(`https://api.plisio.net/api/v1/operations/withdraw`, {
            params: {
                api_key: PLISIO_API_KEY,
                currency: currency,
                amount: amount,
                to: destinationAddress
            }
        });

        if (payoutResponse.data.status === 'success') {
            const payoutData = payoutResponse.data.result;

            // Deduct balance atomically via RPC
            await supabase.rpc('increment_balance', {
                p_user_id: userId,
                p_currency: currency,
                p_amount: -Math.abs(amount)
            });

            // Log withdrawal transaction
            await supabase.from('transactions').insert([{
                user_id: userId,
                type: 'WITHDRAWAL',
                currency: currency,
                amount: amount,
                txn_id: payoutData.txn_id || `WTH-${Date.now()}`,
                status: 'completed'
            }]);

            res.json({ success: true, result: payoutData });
        } else {
            res.status(400).json({ success: false, error: payoutResponse.data.message || 'Withdrawal failed.' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.response?.data || err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
