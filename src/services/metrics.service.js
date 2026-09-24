'use strict';

const { QueryTypes } = require('sequelize');
const inTx = require('../db/inTx');
const { sequelize } = require('../models');

const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null); // % com 1 casa

/**
 * Funil: cliques no link -> conversas -> qualificados -> transferidos -> visitas.
 * Todas as taxas são calculadas aqui (backend), nunca recebidas do cliente.
 */
async function funnel(tenantId, { propertyId, from, to }) {
  const replacements = {
    propertyId: propertyId || null,
    from: from || '1970-01-01T00:00:00Z',
    to: to || '9999-12-31T00:00:00Z',
  };

  const [row] = await inTx(tenantId, (t) =>
    sequelize.query(
      `SELECT
         (SELECT count(*) FROM aim_link_click c
           WHERE (:propertyId::uuid IS NULL OR c.property_id = :propertyId::uuid)
             AND c.created_at >= :from::timestamptz AND c.created_at < :to::timestamptz)::int AS clicks,
         count(l.*)::int                                                          AS leads,
         count(*) FILTER (WHERE l.classification = 'quente')::int                 AS quentes,
         count(*) FILTER (WHERE l.classification = 'morno')::int                  AS mornos,
         count(*) FILTER (WHERE l.classification = 'frio')::int                   AS frios,
         count(*) FILTER (WHERE l.classification = 'indefinido')::int             AS indefinidos,
         count(*) FILTER (WHERE l.handoff_at IS NOT NULL)::int                    AS transferidos,
         count(*) FILTER (WHERE l.status = 'visita_agendada')::int                AS visitas
       FROM aim_lead l
       WHERE (:propertyId::uuid IS NULL OR l.property_id = :propertyId::uuid)
         AND l.created_at >= :from::timestamptz AND l.created_at < :to::timestamptz`,
      { replacements, type: QueryTypes.SELECT, transaction: t }
    )
  );

  return {
    ...row,
    taxas: {
      cliqueParaConversa: rate(row.leads, row.clicks),
      conversaParaQualificado: rate(row.quentes + row.mornos, row.leads),
      conversaParaVisita: rate(row.visitas, row.leads),
    },
  };
}

module.exports = { funnel };
