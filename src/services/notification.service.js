'use strict';

const env = require('../config/env');
const logger = require('../config/logger');
const wa = require('./whatsapp/client');

const CLASS_LABEL = { quente: 'Quente', morno: 'Morno', frio: 'Frio', indefinido: 'Indefinido' };

/**
 * Avisa o dono/corretor que um lead foi transferido.
 * Mensagem para o dono é iniciada pela empresa -> exige TEMPLATE aprovado na Meta
 * (WA_OWNER_ALERT_TEMPLATE) com 4 variáveis no corpo: {{1}} nome, {{2}} imóvel, {{3}} classificação, {{4}} preferência de visita.
 * Sem template configurado, só registra no log (sem PII) e o lead aparece na API de leads.
 */
async function notifyHandoff(tenant, lead, property) {
  if (!tenant.ownerWhatsapp || !env.WA_OWNER_ALERT_TEMPLATE) {
    logger.info({ leadId: lead.id, classification: lead.classification }, 'Lead transferido (sem alerta configurado)');
    return;
  }
  try {
    await wa.sendTemplate(tenant.waPhoneNumberId, tenant.ownerWhatsapp, env.WA_OWNER_ALERT_TEMPLATE, env.WA_OWNER_ALERT_TEMPLATE_LANG, [
      lead.displayName || 'Sem nome',
      property ? `#${property.code}` : 'não definido',
      CLASS_LABEL[lead.classification] || lead.classification,
      lead.visitPreference || '-',
    ]);
  } catch (err) {
    // Falha no alerta não pode derrubar o atendimento.
    logger.error({ leadId: lead.id, code: err.code }, 'Falha ao alertar dono sobre lead transferido');
  }
}

module.exports = { notifyHandoff };
