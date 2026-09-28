'use strict';

/**
 * Avaliação do atendimento com a IA DE VERDADE (não é teste automático: custa chamadas à Anthropic).
 *
 * Conversa como se fosse o lead, pelo simulador do painel (POST /api/v1/dev/inbound), contra o servidor
 * local rodando com WA_MOCK=true. Cada cenário segue um roteiro fixo; ao fim, confere o estado do lead
 * (classificação, fatos, imóvel, visita, transferência) e grava um relatório com as conversas.
 *
 *   AVALIAR_SENHA=<senha> npm run avaliar -- --conta curta --email equipe@curta-demo.com.br [--cenarios aluguel] [--so id1,id2] [--paralelo 4]
 *
 * Só fora de produção (usa a rota do simulador). Os leads criados ficam na conta, como conversas de demonstração.
 */

const fs = require('fs');
const path = require('path');

const API = process.env.AVALIAR_API || 'http://localhost:3000/api/v1';

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(pathname, { method = 'GET', body, token } = {}, tentativa = 0) {
  const r = await fetch(API + pathname, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Limite de requisições da API (proteção do sistema): espera e tenta de novo.
  if (r.status === 429 && tentativa < 6) {
    await sleep(15000);
    return call(pathname, { method, body, token }, tentativa + 1);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${pathname}: ${r.status} ${JSON.stringify(j.error || j)}`);
  return j.data;
}

const NOMES = ['Mariana Souza', 'Rafael Lima', 'Juliana Costa', 'Pedro Alves', 'Camila Rocha', 'Lucas Martins', 'Fernanda Dias', 'Gustavo Ramos', 'Aline Ferreira', 'Thiago Nunes', 'Patrícia Gomes', 'Diego Carvalho'];

async function rodarCenario(sessao, cenario, i) {
  const phone = `55479${String(Date.now()).slice(-6)}${String(i).padStart(2, '0')}`;
  const nome = NOMES[i % NOMES.length];
  let leadId = null;
  let ultimaSaida = 0;
  const inicio = Date.now();

  for (const texto of cenario.mensagens) {
    const antes = new Date();
    await call('/dev/inbound', { method: 'POST', token: sessao.token(), body: { phone, name: nome, text: texto } });
    // Espera a resposta (mensagem de saída posterior ao envio), até 90 s.
    const limite = Date.now() + 90000;
    for (;;) {
      await sleep(3000); // espaçado: 4 cenários em paralelo não podem estourar o limite da API
      if (!leadId) {
        const lista = await call('/leads?limit=100', { token: sessao.token() });
        leadId = lista.items.find((l) => l.phone === phone)?.id || null;
        if (!leadId) { if (Date.now() > limite) throw new Error('lead não apareceu'); continue; }
      }
      const d = await call(`/leads/${leadId}`, { token: sessao.token() });
      const saidas = d.messages.filter((m) => m.direction === 'out' && new Date(m.createdAt) >= antes);
      if (saidas.length > 0 && d.messages.filter((m) => m.direction === 'out').length > ultimaSaida) {
        ultimaSaida = d.messages.filter((m) => m.direction === 'out').length;
        break;
      }
      // Lead que não recebe mais resposta (opt-out já tratado, transferido sem retorno): segue.
      if (Date.now() > limite) break;
    }
  }

  const lead = await call(`/leads/${leadId}`, { token: sessao.token() });
  const visitas = (await call('/visits', { token: sessao.token() })).visits.filter((v) => v.lead.id === leadId);
  const ctx = {
    lead,
    messages: lead.messages,
    replies: lead.messages.filter((m) => m.direction === 'out' && m.author === 'bot').map((m) => m.text),
    visits: visitas,
    properties: sessao.properties,
  };
  let checks;
  try {
    checks = cenario.verificar(ctx).map(([desc, ok]) => ({ desc, ok: Boolean(ok) }));
  } catch (err) {
    checks = [{ desc: `erro ao verificar: ${err.message}`, ok: false }];
  }
  return { cenario, lead, visitas, checks, segundos: Math.round((Date.now() - inicio) / 1000) };
}

function relatorio(resultados, conta) {
  const total = resultados.reduce((n, r) => n + r.checks.length, 0);
  const ok = resultados.reduce((n, r) => n + r.checks.filter((c) => c.ok).length, 0);
  const linhas = [
    `# Avaliação do atendimento: ${conta}`,
    '',
    `Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. IA de verdade, WhatsApp simulado. Dados fictícios.`,
    '',
    `**Resultado: ${ok} de ${total} verificações passaram** em ${resultados.length} cenários.`,
    '',
    '| Cenário | Verificações | Situação final |',
    '|---|---|---|',
    ...resultados.map((r) => `| ${r.cenario.titulo} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} | ${r.lead.status} · ${r.lead.classification}${r.lead.property ? ` · ${r.lead.property.code}` : ''} |`),
    '',
  ];
  for (const r of resultados) {
    linhas.push(`## ${r.cenario.titulo}`, '');
    for (const c of r.checks) linhas.push(`- ${c.ok ? '✅' : '❌'} ${c.desc}`);
    const q = r.lead.qualification;
    linhas.push(
      '',
      `Estado final: ${r.lead.status}, ${r.lead.classification}, imóvel ${r.lead.property?.code || '-'}, renda ${q.monthlyIncomeCents === null ? '-' : q.monthlyIncomeCents / 100}, garantia ${q.guarantee || '-'}, moradores ${q.occupants ?? '-'}, pet ${q.hasPets ?? '-'}, prazo ${q.moveInDays ?? '-'}, visita ${r.visitas.map((v) => v.label).join(', ') || '-'}.`,
      ''
    );
    if (r.lead.disqualifyReasons.length) linhas.push(`Motivos: ${r.lead.disqualifyReasons.join(', ')}.`, '');
    if (r.lead.openQuestions.length) linhas.push(`Dúvidas registradas: ${r.lead.openQuestions.join(' | ')}.`, '');
    if (r.lead.handoffSummary) linhas.push(`Resumo para o corretor: ${r.lead.handoffSummary}`, '');
    linhas.push('<details><summary>Conversa</summary>', '');
    for (const m of r.lead.messages) {
      const quem = m.direction === 'in' ? '**Lead**' : m.author === 'bot' ? '**Assistente**' : `**${m.author}**`;
      linhas.push(`${quem}: ${String(m.text).replace(/\n+/g, ' ')}`, '');
    }
    linhas.push('</details>', '');
  }
  return { texto: linhas.join('\n'), ok, total };
}

async function main() {
  const o = args(process.argv.slice(2));
  const conta = o.conta;
  const email = o.email;
  const senha = process.env.AVALIAR_SENHA;
  if (!conta || !email || !senha) throw new Error('Use: AVALIAR_SENHA=<senha> npm run avaliar -- --conta <slug> --email <email>');
  let cenarios = require(path.join(__dirname, 'cenarios', `${o.cenarios || 'aluguel'}.js`));
  if (o.so) cenarios = cenarios.filter((c) => String(o.so).split(',').includes(c.id));
  const paralelo = Number(o.paralelo || 4);

  let token = (await call('/auth/login', { method: 'POST', body: { tenant: conta, email, password: senha } })).accessToken;
  const renovar = setInterval(async () => {
    try { token = (await call('/auth/login', { method: 'POST', body: { tenant: conta, email, password: senha } })).accessToken; } catch { /* tenta de novo */ }
  }, 10 * 60 * 1000);
  const sessao = { token: () => token, properties: await call('/properties', { token }) };

  const resultados = new Array(cenarios.length);
  let proximo = 0;
  await Promise.all(
    Array.from({ length: Math.min(paralelo, cenarios.length) }, async () => {
      while (proximo < cenarios.length) {
        const i = proximo++;
        const c = cenarios[i];
        process.stdout.write(`▶ ${c.id}\n`);
        try {
          resultados[i] = await rodarCenario(sessao, c, i);
          const r = resultados[i];
          process.stdout.write(`  ${r.checks.every((x) => x.ok) ? 'OK ' : 'FALHOU'} ${c.id} (${r.checks.filter((x) => x.ok).length}/${r.checks.length}, ${r.segundos}s)\n`);
        } catch (err) {
          resultados[i] = { cenario: c, lead: { status: 'erro', classification: '-', qualification: {}, disqualifyReasons: [], openQuestions: [], messages: [] }, visitas: [], checks: [{ desc: `erro: ${err.message}`, ok: false }], segundos: 0 };
          process.stdout.write(`  ERRO ${c.id}: ${err.message}\n`);
        }
      }
    })
  );
  clearInterval(renovar);

  const { texto, ok, total } = relatorio(resultados, conta);
  const dir = path.join(__dirname, '..', 'docs', 'avaliacao');
  fs.mkdirSync(dir, { recursive: true });
  const arquivo = path.join(dir, `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${conta}.md`);
  fs.writeFileSync(arquivo, texto);
  console.log(`\n${ok}/${total} verificações passaram. Relatório: ${path.relative(process.cwd(), arquivo)}`);
}

main().catch((err) => {
  console.error('Falha:', err.message);
  process.exit(1);
});
