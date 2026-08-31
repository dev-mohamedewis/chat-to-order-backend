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
  apiKey: { type: String, required: true, unique: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  orderLimit: { type: Number, default: 100 },
  ordersUsed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const Merchant = mongoose.models.Merchant || mongoose.model('Merchant', merchantSchema);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await connectToDatabase();

    // إنشاء تاجر جديد
    if (req.method === 'POST') {
      const { adminKey, name, email, orderLimit } = req.body;
      
      // تأكد من تطابق كلمة سر الأدمن مع المتواجدة في متغيرات البيئة بـ Vercel
      if (adminKey !== process.env.ADMIN_SECRET_KEY) {
        return res.status(401).json({ success: false, error: 'كلمة سر الأدمن غير صحيحة' });
      }

      const apiKey = 'cto_live_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
      const newMerchant = new Merchant({ 
        name, 
        email, 
        apiKey, 
        orderLimit: Number(orderLimit) || 100 
      });
      
      await newMerchant.save();
      return res.json({ success: true, merchant: newMerchant });
    }

    // جلب قائمة كل التجار (اختياري للأدمن)
    if (req.method === 'GET') {
      const { adminKey } = req.query;
      if (adminKey !== process.env.ADMIN_SECRET_KEY) {
        return res.status(401).json({ success: false, error: 'غير مصرح' });
      }
      const merchants = await Merchant.find({}).sort({ createdAt: -1 });
      return res.json({ success: true, merchants });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}