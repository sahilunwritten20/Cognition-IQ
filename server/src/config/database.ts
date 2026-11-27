import mongoose from 'mongoose';

export async function connectDatabase(uri: string, maxPoolSize = 100): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, maxPoolSize });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export async function isDatabaseReady(): Promise<boolean> {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return false;
  try {
    await mongoose.connection.db.admin().ping();
    return true;
  } catch {
    return false;
  }
}
