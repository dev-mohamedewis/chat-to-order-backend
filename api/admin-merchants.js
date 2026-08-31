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

const Merchant = mongoose.models.Merchant || mongoose.model('Merchant', merchantSchema);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await connectToDatabase();

    // جلب قائمة كل التجار
    if (req.method === 'GET') {
      const { adminKey } = req.query;
      if (adminKey !== process.env.ADMIN_SECRET_KEY) {
        return res.status(401).json({ success: false, error: 'غير مصرح' });
      }
      const merchants = await Merchant.find({}).sort({ createdAt: -1 });
      return res.json({ success: true, merchants });
    }

    // إنشاء تاجر جديد
    if (req.method === 'POST') {
      const { adminKey, name, email, googleSheetUrl, orderLimit } = req.body;
      
      if (adminKey !== process.env.ADMIN_SECRET_KEY) {
        return res.status(401).json({ success: false, error: 'كلمة سر الأدمن غير صحيحة' });
      }

      const apiKey = 'cto_live_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
      const newMerchant = new Merchant({ 
        name, 
        email, 
        googleSheetUrl,
        apiKey, 
        orderLimit: Number(orderLimit) || 100 
      });
      
      await newMerchant.save();
      return res.json({ success: true, merchant: newMerchant });
    }

    // تعديل حالة التاجر (إيقاف / تفعيل)
    if (req.method === 'PATCH') {
      const { adminKey, status, merchantId } = req.body;
      
      if (adminKey !== process.env.ADMIN_SECRET_KEY) {
        return res.status(401).json({ success: false, error: 'غير مصرح' });
      }

      const { id } = req.query; // الـ ID اللي جاي من الـ URL
      const targetId = id || merchantId;

      const updatedMerchant = await Merchant.findByIdAndUpdate(
        targetId, 
        { status }, 
        { new: true }
      );

      if (!updatedMerchant) {
        return res.status(404).json({ success: false, error: 'التاجر غير موجود' });
      }

      return res.json({ success: true, merchant: updatedMerchant });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}