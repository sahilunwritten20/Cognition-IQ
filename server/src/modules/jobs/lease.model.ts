import { Schema, model } from 'mongoose';
import { duplicateKey } from '../../common/mongo';

interface IJobLease {
  _id: string;
  leaseUntil: Date;
}

const leaseSchema = new Schema<IJobLease>(
  { _id: { type: String, required: true }, leaseUntil: { type: Date, required: true } },
  { collection: 'joblocks' },
);
export const JobLease = model<IJobLease>('JobLease', leaseSchema);

/**
 * Takes a named lease for `ms`. Exactly one caller wins across all API/worker instances; the others get false.
 * Works without Redis: the unique _id does the arbitration (a held lease makes the upsert hit a duplicate key).
 */
export async function acquireLease(name: string, ms: number, now: Date): Promise<boolean> {
  try {
    await JobLease.findOneAndUpdate(
      { _id: name, leaseUntil: { $lt: now } },
      { $set: { leaseUntil: new Date(now.getTime() + ms) } },
      { upsert: true, new: true },
    );
    return true;
  } catch (err) {
    if (duplicateKey(err)) return false;
    throw err;
  }
}
