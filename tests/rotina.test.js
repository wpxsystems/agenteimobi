'use strict';

// Fase 2 sem banco: fuso horário, grade e horários livres, avisos e resumo.

const { zonedToUtc, localParts, localDate, slotLabel, isValidTimezone, offsetMs } = require('../src/services/time');
const { parseSchedule, freeSlots, pickOffer } = require('../src/services/visit/slots');
const { diffAlerts, eventKindFor } = require('../src/services/quality.service');
const { isRelevant } = require('../src/services/digest.service');
const { buildSystemPrompt } = require('../src/services/ai/prompt');
const { toInternal, outputSchema } = require('../src/services/ai/claude.client');

const SP = 'America/Sao_Paulo';
const H = 3600e3;

describe('fuso horário', () => {
  test('São Paulo é UTC-3; hora local vira o instante certo', () => {
    const d = zonedToUtc({ y: 2026, m: 9, d: 25, h: 14, mi: 0 }, SP);
    expect(d.toISOString()).toBe('2026-09-25T17:00:00.000Z');
    expect(offsetMs(d, SP)).toBe(-3 * H);
    expect(zonedToUtc({ y: 2026, m: 9, d: 25, h: 14, mi: 0 }, 'America/Manaus').toISOString()).toBe('2026-09-25T18:00:00.000Z');
  });

  test('virada do dia local diferente da UTC', () => {
    const d = new Date('2026-09-26T01:30:00Z'); // 22:30 do dia 25 em São Paulo
    expect(localDate(d, SP)).toBe('2026-09-25');
    expect(localParts(d, SP)).toMatchObject({ d: 25, h: 22, weekday: 5 });
  });

  test('rótulo e validação de fuso', () => {
    expect(slotLabel(new Date('2026-09-30T13:00:00Z'), SP)).toBe('qua 30/09 às 10:00');
    expect(isValidTimezone(SP)).toBe(true);
    expect(isValidTimezone('America/Nowhere')).toBe(false);
    expect(isValidTimezone('SP')).toBe(false);
  });
});

describe('grade de visitas', () => {
  test('valida duração, formato, sobreposição e faixa menor que a visita', () => {
    expect(parseSchedule({ slotMinutes: 60, days: { 1: ['09:00-12:00'] } }).days['1']).toEqual([{ start: 540, end: 720, text: '09:00-12:00' }]);
    expect(() => parseSchedule({ slotMinutes: 50, days: {} })).toThrow(/Duração/);
    expect(() => parseSchedule({ slotMinutes: 60, days: { 1: ['9h-12h'] } })).toThrow(/Faixa inválida/);
    expect(() => parseSchedule({ slotMinutes: 60, days: { 1: ['09:00-12:00', '11:00-13:00'] } })).toThrow(/sobrepostas/);
    expect(() => parseSchedule({ slotMinutes: 60, days: { 1: ['09:00-09:30'] } })).toThrow(/menor/);
    expect(() => parseSchedule({ slotMinutes: 60, days: { 7: ['09:00-12:00'] } })).toThrow(/Dia inválido/);
  });

  // Sexta 25/09/2026 09:30 em São Paulo
  const now = new Date('2026-09-25T12:30:00Z');
  const grade = { slotMinutes: 60, days: { 1: ['09:00-12:00', '14:00-18:00'], 5: ['09:00-12:00', '14:00-18:00'], 6: ['09:00-12:00'] } };
  const rotulos = (list) => list.map((d) => slotLabel(d, SP));

  test('respeita a antecedência mínima de 2 h e os dias da grade', () => {
    const s = rotulos(freeSlots({ schedule: grade, now, timezone: SP, days: 4 }));
    expect(s[0]).toBe('sex 25/09 às 14:00'); // 10h e 11h ficam a menos de 2 h
    expect(s).not.toContain('sex 25/09 às 11:00');
    expect(s.some((x) => x.startsWith('dom'))).toBe(false); // domingo sem grade
    expect(s.filter((x) => x.startsWith('sáb'))).toEqual(['sáb 26/09 às 09:00', 'sáb 26/09 às 10:00', 'sáb 26/09 às 11:00']);
    expect(s.at(-1)).toBe('seg 28/09 às 17:00'); // última visita começa 1 h antes do fim da faixa
  });

  test('horário ocupado (inclusive parcialmente) sai da lista', () => {
    const busy = [{ start: new Date('2026-09-25T17:30:00Z'), end: new Date('2026-09-25T18:30:00Z') }]; // 14:30-15:30 local
    const s = rotulos(freeSlots({ schedule: grade, busy, now, timezone: SP, days: 1 }));
    expect(s).toEqual(['sex 25/09 às 16:00', 'sex 25/09 às 17:00']);
  });

  test('oferta: no máximo 2 por dia (manhã e tarde) e 6 no total', () => {
    const all = freeSlots({ schedule: grade, now, timezone: SP, days: 7 });
    const oferta = rotulos(pickOffer(all, { timezone: SP }));
    expect(oferta).toEqual(['sex 25/09 às 14:00', 'sex 25/09 às 15:00', 'sáb 26/09 às 09:00', 'sáb 26/09 às 10:00', 'seg 28/09 às 09:00', 'seg 28/09 às 14:00']);
  });
});

describe('avisos de qualidade', () => {
  test('cria o que apareceu, resolve o que sumiu, não mexe em aviso de evento', () => {
    const open = [
      { id: 'a1', kind: 'lead_sem_retorno', leadId: 'L1', propertyId: null },
      { id: 'a2', kind: 'sem_resposta', leadId: 'L2', propertyId: null },
      { id: 'a3', kind: 'falha_envio', leadId: 'L3', propertyId: null },
    ];
    const current = [
      { kind: 'lead_sem_retorno', leadId: 'L1', propertyId: null },
      { kind: 'cadastro_incompleto', leadId: null, propertyId: 'P1' },
    ];
    const d = diffAlerts(open, current);
    expect(d.toCreate).toEqual([{ kind: 'cadastro_incompleto', leadId: null, propertyId: 'P1' }]);
    expect(d.toResolve).toEqual(['a2']);
  });

  test('tipo do aviso pelo código do erro', () => {
    expect(eventKindFor('WHATSAPP_SEND_FAILED')).toBe('falha_envio');
    expect(eventKindFor('AI_INVALID_OUTPUT')).toBe('ia_invalida');
    expect(eventKindFor(undefined)).toBe('falha_resposta');
  });

  test('resumo só é relevante com algo para o dono ver', () => {
    const zero = { aguardando: 0, novosOntem: 0, visitasHoje: 0, avisos: 0 };
    expect(isRelevant(zero)).toBe(false);
    expect(isRelevant({ ...zero, visitasHoje: 1 })).toBe(true);
  });
});

describe('IA e horários de visita', () => {
  const base = { tenant: { assistantName: 'Ana', name: 'Imob' }, property: null, activeProperties: [], lead: { qualification: {}, classification: 'indefinido' }, today: 'hoje' };

  test('com horários: lista no prompt e regra de escolher pelo id', () => {
    const p = buildSystemPrompt({ ...base, visitSlots: [{ id: '2026-09-25T17:00:00.000Z', label: 'sex 25/09 às 14:00' }] });
    expect(p).toContain('<horarios_disponiveis>');
    expect(p).toContain('sex 25/09 às 14:00 (id: 2026-09-25T17:00:00.000Z)');
    expect(p).toContain('preencha "horario_visita" com o id exato');
  });

  test('sem horários: regra clássica de passar para o corretor', () => {
    const p = buildSystemPrompt({ ...base, visitSlots: [] });
    expect(p).not.toContain('<horarios_disponiveis>');
    expect(p).toContain('um corretor vai entrar em contato para fechar o horário');
  });

  test('horario_visita passa pela validação e vira visitSlot', () => {
    const out = outputSchema.parse({
      resposta: 'Marcado!', fatos: {}, codigo_imovel: null, preferencia_visita: null, horario_visita: '2026-09-25T17:00:00.000Z',
      proxima_acao: 'continuar', motivo_transferencia: null, resumo_para_corretor: null, duvidas_sem_resposta: [],
    });
    expect(toInternal(out).visitSlot).toBe('2026-09-25T17:00:00.000Z');
    expect(() => outputSchema.parse({ ...out, horario_visita: 'x'.repeat(41) })).toThrow();
  });
});
