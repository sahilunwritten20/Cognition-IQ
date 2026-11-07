import { Schema, model, type Types } from 'mongoose';

export interface IAuditLog {
  collegeId: Types.ObjectId;
  actorId?: Types.ObjectId;
  action: string;
  targetType?: string;
  targetId?: string;
  summary?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
  at: Date;
}

const auditSchema = new Schema<IAuditLog>(
  {
    collegeId: { type: Schema.Types.ObjectId, required: true },
    actorId: { type: Schema.Types.ObjectId },
    action: { type: String, required: true },
    targetType: { type: String },
    targetId: { type: String },
    summary: { type: Schema.Types.Mixed },
    requestId: { type: String },
    ip: { type: String },
  },
  { timestamps: { createdAt: 'at', updatedAt: false } },
);
auditSchema.index({ collegeId: 1, at: -1 });
auditSchema.index({ collegeId: 1, action: 1, at: -1 });

export const AuditLog = model<IAuditLog>('AuditLog', auditSchema);
