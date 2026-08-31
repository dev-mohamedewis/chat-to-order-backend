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
  apiKey: String,
  status: String
});

const orderSchema = new mongoose.Schema({
  merchantId: mongoose.Schema.Types.ObjectId,
  customerName: String,
  phone: String,
  secondary_phone: String,
  governorate: String,
  city: String,
  address: String,
  landmark: String,
  items: String,
  shippingMethod: String,
  shippingCompany: String,
  paymentMethod: String,
  paymentStatus: String,
  status: String,
  notes: String
});

const Merchant = mongoose.models.Merchant || mongoose.model('Merchant', merchantSchema);
const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    await connectToDatabase();
    const { apiKey, orderId, ...updateData } = req.body;

    if (!apiKey || !orderId) {
      return res.status(400).json({ success: false, error: 'مفتاح الـ API ومُعرف الطلب مطلوبان' });
    }

    const merchant = await Merchant.findOne({ apiKey });
    if (!merchant || merchant.status !== 'active') {
      return res.status(403).json({ success: false, error: 'مفتاح غير صحيح أو حساب موقوف' });
    }

    // تحديث الأوردر والتأكد إنه يخص التاجر ده بس للأمان
    const updatedOrder = await Order.findOneAndUpdate(
      { _id: orderId, merchantId: merchant._id },
      { $set: updateData },
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({ success: false, error: 'الطلب غير موجود أو لا تملك صلاحية تعديله' });
    }

    return res.json({ success: true, message: 'تم تحديث الطلب بنجاح', order: updatedOrder });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}