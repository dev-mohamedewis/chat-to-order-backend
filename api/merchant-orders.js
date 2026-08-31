import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

let isConnected = false;
async function connectToDatabase() {
  if (isConnected && mongoose.connection.readyState === 1) return;
  await mongoose.connect(process.env.MONGODB_URI);
  isConnected = true;
}

const merchantSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  googleSheetUrl: { type: String, required: true },
  apiKey: { type: String, required: true, unique: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  orderLimit: { type: Number, default: 100 },
  ordersUsed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
  customerName: String,
  phone: String,
  secondary_phone: String,
  governorate: String,
  city: String,
  address: String,
  landmark: String,
  items: String,
  notes: String,
  createdAt: { type: Date, default: Date.now }
});

const Merchant = mongoose.models.Merchant || mongoose.model('Merchant', merchantSchema);
const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await connectToDatabase();
    
    const apiKey = req.query.apiKey || req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'مفتاح الـ API مفقود' });
    }

    const merchant = await Merchant.findOne({ apiKey });
    if (!merchant) {
      return res.status(403).json({ success: false, error: 'مفتاح غير صحيح أو غير مسجل' });
    }

    if (merchant.status === 'suspended') {
      return res.status(403).json({ success: false, error: 'هذا الحساب موقوف مؤقتاً من قبل الإدارة' });
    }

   const orders = await Order.find({ merchantId: merchant._id }).sort({ createdAt: -1 });
    
    return res.json({ 
      success: true, 
      merchantName: merchant.name,
      merchantData: {
        orderLimit: merchant.orderLimit || 100,
        ordersUsed: merchant.ordersUsed || 0,
        status: merchant.status || 'active'
      },
      orders 
    });
    
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}