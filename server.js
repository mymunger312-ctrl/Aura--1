const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");
const orderLocks = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of orderLocks.entries()) {
    if (now - value.time > 60 * 60 * 1000) {
      orderLocks.delete(key);
    }
  }
}, 30 * 60 * 1000);
const fs = require("fs");
if (!process.env.SIGN_SECRET) {
  throw new Error("SIGN_SECRET is missing");
}
const SECRET = process.env.SIGN_SECRET;
async function getPriceFromSheet(productURL) {
  const res = await fetch(process.env.SHEET_API_URL);
  const data = await res.json();

  const product = data.find(p => p["Product URL"] === productURL);

  if (!product) return null;

  return Number(product["Per Piece Price"] || product.price);
}
const app = express();
app.use(express.json());
app.use(cors());

// 🔐 USE ENV VARIABLES (IMPORTANT)
const razorpay = new Razorpay({
  key_id: process.env.KEY_ID,
  key_secret: process.env.KEY_SECRET
});
function createCheckoutToken(productURL, quantity) {
  return crypto
    .createHmac("sha256", SECRET)
    .update(productURL + "|" + quantity)
    .digest("hex");
}

function verifyCheckoutToken(productURL, quantity, token) {
  const valid = createCheckoutToken(productURL, quantity);
  return valid === token;
}
async function calculateAmount(productURL, quantity) {
  const pricePerItem = await getPriceFromSheet(productURL);

  if (!pricePerItem || isNaN(pricePerItem)) {
    throw new Error("Invalid price from sheet");
  }

  return pricePerItem * quantity;
}
// ✅ CREATE ORDER
app.post("/create-order", async (req, res) => {
  try {
    const { productURL, quantity, receipt, token } = req.body;

    if (token && !verifyCheckoutToken(productURL, quantity, token)) {
  return res.status(403).json({ error: "Invalid checkout token" });
}

    if (!productURL || !quantity || quantity <= 0) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const amount = await calculateAmount(productURL, quantity);

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: receipt
    });

    // 🔒 STORE LOCK (temporary memory lock)
    orderLocks.set(order.id, {
      status: "created",
      time: Date.now()
    });

    res.json({
      orderId: order.id,
      amountInPaise: order.amount,
      token: createCheckoutToken(productURL, quantity)
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Order creation failed" });
  }
});

// ✅ VERIFY PAYMENT
app.post("/verify-payment", (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    const lock = orderLocks.get(razorpay_order_id);

    // 🔒 prevent replay
    if (lock && lock.status === "paid") {
      return res.status(409).json({
        status: "duplicate",
        message: "Order already processed"
      });
    }

    const generated_signature = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (generated_signature === razorpay_signature) {

      orderLocks.set(razorpay_order_id, {
        status: "paid",
        time: Date.now()
      });

      return res.json({
        status: "verified",
        message: "Payment valid"
      });
    }

    return res.status(400).json({
      status: "failed",
      message: "Invalid signature"
    });

  } catch (err) {
    res.status(500).json({ error: "Verification failed" });
  }
});

app.post("/razorpay-webhook", (req, res) => {
  try {
    const secret = process.env.WEBHOOK_SECRET;
if (!secret) {
  return res.status(500).send("Webhook secret missing");
}

    const shasum = crypto.createHmac("sha256", secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest("hex");

    if (digest !== req.headers["x-razorpay-signature"]) {
      return res.status(400).send("Invalid signature");
    }

    const event = req.body.event;

    if (event === "payment.captured") {
      const payment = req.body.payload.payment.entity;

      orderLocks.set(payment.order_id, {
        status: "paid",
        webhook: true,
        time: Date.now()
      });

      console.log("ORDER CONFIRMED VIA WEBHOOK:", payment.order_id);
    }

    res.json({ status: "ok" });

  } catch (e) {
    res.status(500).send("Webhook error");
  }
});

app.post("/create-cod-order", async (req, res) => {
  try {
    const { productURL, quantity } = req.body;

    const amount = await calculateAmount(productURL, quantity);

    // 🔥 ADD THIS HERE (RIGHT AFTER AMOUNT CALCULATION)
    orderLocks.set(productURL + "|" + Date.now(), {
      status: "cod",
      time: Date.now()
    });

    // ONLY STORE ORDER (NO PAYMENT)
    res.json({
      success: true,
      amount
    });

  } catch (err) {
    res.status(500).json({ success: false });
  }
});
