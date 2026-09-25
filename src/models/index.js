'use strict';

// Models: só mapping de tabela. Regra de negócio fica nos services.
const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const bigintAsNumber = (field) => ({
  type: DataTypes.BIGINT,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : Number(v);
  },
});

const Tenant = sequelize.define('aim_tenant', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  slug: DataTypes.TEXT,
  name: DataTypes.TEXT,
  assistantName: DataTypes.TEXT,
  waPhoneNumberId: DataTypes.TEXT,
  waDisplayPhone: DataTypes.TEXT,
  ownerWhatsapp: DataTypes.TEXT,
  waWabaId: DataTypes.TEXT,
  // Token do WhatsApp cifrado (src/services/crypto.js). Nunca sai no toJSON nem em serializer.
  waAccessTokenEnc: DataTypes.TEXT,
  waTokenUpdatedAt: DataTypes.DATE,
  onboarding: DataTypes.JSONB,
  retentionMonths: DataTypes.INTEGER,
  timezone: DataTypes.TEXT,
  handoffSlaMinutes: DataTypes.INTEGER,
  digestEnabled: DataTypes.BOOLEAN,
  visitSchedule: DataTypes.JSONB,
  isActive: DataTypes.BOOLEAN,
});
Tenant.prototype.toJSON = function toJSON() {
  const { waAccessTokenEnc, ...rest } = this.get();
  return rest;
};

const User = sequelize.define(
  'aim_user',
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    tenantId: { type: DataTypes.UUID, allowNull: false },
    name: DataTypes.TEXT,
    email: DataTypes.TEXT,
    passwordHash: DataTypes.TEXT,
    role: DataTypes.TEXT,
    isActive: DataTypes.BOOLEAN,
    emailVerifiedAt: DataTypes.DATE,
  },
  {
    defaultScope: { attributes: { exclude: ['passwordHash'] } },
    scopes: { withPassword: { attributes: { include: ['passwordHash'] } } },
  }
);
User.prototype.toJSON = function toJSON() {
  const { passwordHash, ...rest } = this.get();
  return rest;
};

const RefreshToken = sequelize.define('aim_refresh_token', {
  id: { type: DataTypes.UUID, primaryKey: true },
  tenantId: { type: DataTypes.UUID, allowNull: false },
  userId: { type: DataTypes.UUID, allowNull: false },
  expiresAt: DataTypes.DATE,
  revokedAt: DataTypes.DATE,
});

const Property = sequelize.define('aim_property', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  tenantId: { type: DataTypes.UUID, allowNull: false },
  code: DataTypes.TEXT,
  title: DataTypes.TEXT,
  description: DataTypes.TEXT,
  locationSummary: DataTypes.TEXT,
  dealType: DataTypes.TEXT,
  priceCents: bigintAsNumber('priceCents'),
  feesCents: bigintAsNumber('feesCents'),
  bedrooms: DataTypes.INTEGER,
  allowsPets: DataTypes.BOOLEAN,
  maxOccupants: DataTypes.INTEGER,
  acceptedGuarantees: DataTypes.ARRAY(DataTypes.TEXT),
  availableFrom: DataTypes.DATEONLY,
  extraInfo: DataTypes.TEXT,
  isActive: DataTypes.BOOLEAN,
});

const Lead = sequelize.define('aim_lead', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  tenantId: { type: DataTypes.UUID, allowNull: false },
  propertyId: DataTypes.UUID,
  waId: DataTypes.TEXT,
  displayName: DataTypes.TEXT,
  status: DataTypes.TEXT,
  classification: DataTypes.TEXT,
  score: DataTypes.INTEGER,
  qualification: DataTypes.JSONB,
  disqualifyReasons: DataTypes.ARRAY(DataTypes.TEXT),
  visitPreference: DataTypes.TEXT,
  botActive: DataTypes.BOOLEAN,
  handoffReason: DataTypes.TEXT,
  handoffSummary: DataTypes.TEXT,
  handoffAt: DataTypes.DATE,
  openQuestions: DataTypes.JSONB,
  lastInboundAt: DataTypes.DATE,
  lastOutboundAt: DataTypes.DATE,
  lastRepliedInboundAt: DataTypes.DATE,
  followupCount: DataTypes.INTEGER,
  privacyNoticeSentAt: DataTypes.DATE,
  optOutAt: DataTypes.DATE,
  source: DataTypes.TEXT,
  anonymizedAt: DataTypes.DATE,
  openQuestionsAt: DataTypes.DATE,
});

const Message = sequelize.define('aim_message', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  tenantId: { type: DataTypes.UUID, allowNull: false },
  leadId: { type: DataTypes.UUID, allowNull: false },
  direction: DataTypes.TEXT,
  author: DataTypes.TEXT,
  waMessageId: DataTypes.TEXT,
  msgType: DataTypes.TEXT,
  body: DataTypes.TEXT,
});

const LinkClick = sequelize.define('aim_link_click', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  tenantId: { type: DataTypes.UUID, allowNull: false },
  propertyId: { type: DataTypes.UUID, allowNull: false },
  source: DataTypes.TEXT,
});

Lead.belongsTo(Property, { foreignKey: 'propertyId', as: 'property' });
Lead.hasMany(Message, { foreignKey: 'leadId', as: 'messages' });
Message.belongsTo(Lead, { foreignKey: 'leadId' });

module.exports = { sequelize, Tenant, User, RefreshToken, Property, Lead, Message, LinkClick };
