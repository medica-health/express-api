import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/cdac_db";

export async function connectMongo(): Promise<void> {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection failed:", (err as Error).message);
  }
}

export async function mongoStatus(): Promise<"up" | "down"> {
  try {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return "down";
    await mongoose.connection.db.admin().ping();
    return "up";
  } catch {
    return "down";
  }
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
