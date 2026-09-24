'use strict';

/**
 * Exportação de leads em CSV e Excel (.xlsx). Recebe DTOs já serializados (nunca o model cru)
 * e monta linhas com rótulos em português, prontas para o corretor abrir no Excel.
 */

const ExcelJS = require('exceljs');

const CLASSE = { quente: 'Quente', morno: 'Morno', frio: 'Frio', indefinido: 'Qualificando' };
const STATUS = {
  novo: 'Novo',
  em_atendimento: 'Em atendimento',
  transferido: 'Transferido ao corretor',
  visita_agendada: 'Visita agendada',
  descartado: 'Descartado',
  opt_out: 'Pediu para sair',
};
const GARANTIA = { fiador: 'Fiador', caucao: 'Caução', seguro_fianca: 'Seguro fiança', titulo_capitalizacao: 'Título de capitalização', sem_garantia: 'Sem garantia' };
const MOTIVO = {
  renda_insuficiente: 'Renda abaixo de 2,5x o custo mensal',
  garantia_nao_aceita: 'Garantia não aceita pelo imóvel',
  pet_nao_permitido: 'Tem pet e o imóvel não permite',
  moradores_acima_limite: 'Moradores acima do limite',
};

const simNao = (v) => (v === null || v === undefined ? '' : v ? 'Sim' : 'Não');
const data = (iso) => (iso ? new Date(iso) : null);

/** Colunas da planilha: { header, key, width, tipo } — tipo decide o formato no Excel. */
const COLUNAS = [
  { header: 'Nome', key: 'nome', width: 24 },
  { header: 'Telefone', key: 'telefone', width: 16 },
  { header: 'Imóvel', key: 'imovel', width: 10 },
  { header: 'Título do imóvel', key: 'imovelTitulo', width: 36 },
  { header: 'Classificação', key: 'classificacao', width: 14 },
  { header: 'Pontos', key: 'pontos', width: 8, tipo: 'int' },
  { header: 'Status', key: 'status', width: 22 },
  { header: 'Renda mensal', key: 'renda', width: 14, tipo: 'moeda' },
  { header: 'Garantia', key: 'garantia', width: 20 },
  { header: 'Moradores', key: 'moradores', width: 10, tipo: 'int' },
  { header: 'Tem pet', key: 'pet', width: 8 },
  { header: 'Mudança em (dias)', key: 'prazo', width: 16, tipo: 'int' },
  { header: 'Quer visitar', key: 'querVisitar', width: 11 },
  { header: 'Preferência de visita', key: 'visita', width: 22 },
  { header: 'Motivos de desqualificação', key: 'motivos', width: 34 },
  { header: 'Dúvidas sem resposta', key: 'duvidas', width: 40 },
  { header: 'Resumo para o corretor', key: 'resumo', width: 60 },
  { header: 'Origem', key: 'origem', width: 10 },
  { header: 'Criado em', key: 'criadoEm', width: 17, tipo: 'data' },
  { header: 'Última mensagem do lead', key: 'ultimaMensagem', width: 20, tipo: 'data' },
  { header: 'Transferido em', key: 'transferidoEm', width: 17, tipo: 'data' },
];

/** Achata o DTO do lead (serializer) numa linha de exportação. */
function leadRow(l) {
  const q = l.qualification || {};
  return {
    nome: l.name || '',
    telefone: l.phone,
    imovel: l.property ? l.property.code : '',
    imovelTitulo: l.property ? l.property.title : '',
    classificacao: CLASSE[l.classification] || l.classification,
    pontos: l.score ?? 0,
    status: STATUS[l.status] || l.status,
    renda: q.monthlyIncomeCents === null || q.monthlyIncomeCents === undefined ? null : q.monthlyIncomeCents / 100,
    garantia: GARANTIA[q.guarantee] || '',
    moradores: q.occupants ?? null,
    pet: simNao(q.hasPets),
    prazo: q.moveInDays ?? null,
    querVisitar: simNao(q.wantsVisit),
    visita: l.visitPreference || '',
    motivos: (l.disqualifyReasons || []).map((r) => MOTIVO[r] || r).join('; '),
    duvidas: (l.openQuestions || []).join('; '),
    resumo: l.handoffSummary || '',
    origem: l.source === 'ctwa' ? 'Anúncio clique-para-WhatsApp' : l.source === 'link' ? 'Link do anúncio' : l.source || '',
    criadoEm: data(l.createdAt),
    ultimaMensagem: data(l.lastInboundAt),
    transferidoEm: data(l.handoffAt),
  };
}

const fmtCsvData = (d) => (d ? d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');
const fmtCsvMoeda = (v) => (v === null || v === undefined ? '' : v.toFixed(2).replace('.', ','));

/** CSV com BOM (Excel em português abre com acentos certos) e ';' como separador. */
function toCsv(rows) {
  const celula = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linha = (r) =>
    COLUNAS.map((c) => {
      const v = r[c.key];
      if (c.tipo === 'data') return celula(fmtCsvData(v));
      if (c.tipo === 'moeda') return celula(fmtCsvMoeda(v));
      return celula(v);
    }).join(';');
  return `﻿${[COLUNAS.map((c) => celula(c.header)).join(';'), ...rows.map(linha)].join('\r\n')}`;
}

/**
 * Escreve o .xlsx no stream de resposta: aba "Leads" (cabeçalho fixo, filtro, larguras, formatos)
 * e aba "Resumo" (filtros usados e números do funil).
 */
async function writeXlsx({ rows, resumo }, stream) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AgenteImobi';
  wb.created = new Date();

  const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUNAS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14213D' } };
  ws.getRow(1).alignment = { vertical: 'middle' };
  ws.getRow(1).height = 22;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUNAS.length } };

  for (const r of rows) ws.addRow(r);

  COLUNAS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.tipo === 'moeda') col.numFmt = '"R$" #,##0.00';
    if (c.tipo === 'data') col.numFmt = 'dd/mm/yyyy hh:mm';
    if (c.tipo === 'int') col.alignment = { horizontal: 'right' };
    if (c.key === 'resumo' || c.key === 'duvidas') col.alignment = { wrapText: true, vertical: 'top' };
  });

  const wr = wb.addWorksheet('Resumo');
  wr.columns = [{ width: 34 }, { width: 22 }];
  const cab = (texto) => {
    const row = wr.addRow([texto]);
    row.font = { bold: true, size: 12 };
    return row;
  };
  cab('Filtros');
  wr.addRow(['Período', resumo.periodo]);
  wr.addRow(['Imóvel', resumo.imovel]);
  wr.addRow(['Gerado em', new Date()]).getCell(2).numFmt = 'dd/mm/yyyy hh:mm';
  wr.addRow([]);
  cab('Funil');
  const f = resumo.funnel;
  wr.addRow(['Cliques no anúncio', f.clicks]);
  wr.addRow(['Conversas iniciadas', f.leads]);
  wr.addRow(['Qualificados (quente ou morno)', f.quentes + f.mornos]);
  wr.addRow(['Transferidos ao corretor', f.transferidos]);
  wr.addRow(['Visitas agendadas', f.visitas]);
  wr.addRow([]);
  cab('Temperatura');
  wr.addRow(['Quentes', f.quentes]);
  wr.addRow(['Mornos', f.mornos]);
  wr.addRow(['Frios', f.frios]);
  wr.addRow(['Ainda qualificando', f.indefinidos]);
  wr.addRow([]);
  wr.addRow(['Leads nesta planilha', rows.length]);

  await wb.xlsx.write(stream);
}

module.exports = { COLUNAS, leadRow, toCsv, writeXlsx };
