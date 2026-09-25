'use strict';

/* AgenteImobi — painel. Sem build: fetch para /api/v1 na mesma origem. */

const API = '/api/v1';
const $ = (id) => document.getElementById(id);

// Preferências e sessão persistidas no navegador. Nunca guarda a senha:
// só o token de acesso (curto) e o refresh token, que o servidor pode revogar a qualquer momento.
const cofre = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* modo privado ou armazenamento bloqueado */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};

const state = {
  accessToken: cofre.get('aim.access') || null,
  refreshToken: cofre.get('aim.refresh') || null,
  user: JSON.parse(cofre.get('aim.user') || 'null'),
  view: 'leads',
  dev: null, // { waMock, aiConfigured, tenant }
  leads: [],
  filtro: '',
  leadId: null,
  lead: null,
  simulado: null, // { phone, name } de um lead que ainda não existe no banco
  aguardandoBotDesde: 0,
  properties: [],
  propertyId: null,
  timers: {},
};

const DASHBOARDS = ['funil', 'anuncios', 'atendimento'];
const VIEWS = ['login', 'leads', 'imoveis', ...DASHBOARDS];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reais = (cents) => (cents === null || cents === undefined ? null : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dataHora = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const telefone = (d) => (d && d.length >= 12 ? `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, -4)}-${d.slice(-4)}` : d || '');

const CLASSE = { quente: 'Quente', morno: 'Morno', frio: 'Frio', indefinido: 'Qualificando' };
const STATUS = {
  novo: 'Novo', em_atendimento: 'Em atendimento', transferido: 'Transferido ao corretor',
  visita_agendada: 'Visita agendada', descartado: 'Descartado', opt_out: 'Pediu para sair',
};
const GARANTIA = { fiador: 'Fiador', caucao: 'Caução', seguro_fianca: 'Seguro fiança', titulo_capitalizacao: 'Título de capitalização', sem_garantia: 'Sem garantia' };
const MOTIVO = {
  renda_insuficiente: 'Renda abaixo de 2,5 vezes o custo mensal',
  garantia_nao_aceita: 'Garantia que o imóvel não aceita',
  pet_nao_permitido: 'Tem pet e o imóvel não permite',
  moradores_acima_limite: 'Mais moradores do que o imóvel comporta',
};
const ORIGEM = { marketplace: 'Marketplace', instagram: 'Instagram', olx: 'OLX', link: 'Link do anúncio', ctwa: 'Anúncio clique-para-WhatsApp', 'sem origem': 'Sem origem', desconhecido: 'Desconhecido' };

function salvarSessao({ accessToken, refreshToken, user }) {
  if (accessToken) { state.accessToken = accessToken; cofre.set('aim.access', accessToken); }
  if (refreshToken) { state.refreshToken = refreshToken; cofre.set('aim.refresh', refreshToken); }
  if (user) { state.user = user; cofre.set('aim.user', JSON.stringify(user)); }
}
function limparSessao() {
  state.accessToken = state.refreshToken = state.user = null;
  ['aim.access', 'aim.refresh', 'aim.user'].forEach((k) => cofre.del(k));
}

/** Quanto falta (ms) para o token de acesso vencer; Infinity se não der para ler. */
function tokenExpiraEm(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp * 1000 - Date.now();
  } catch {
    return Infinity;
  }
}

/**
 * Renova a sessão UMA vez por vez. O refresh token é de uso único: se duas chamadas
 * paralelas o usassem ao mesmo tempo, o servidor trataria a segunda como reuso e
 * revogaria a sessão inteira. Todas as chamadas esperam a mesma renovação.
 */
let renovando = null;
function renovarSessao() {
  if (!state.refreshToken) return Promise.resolve(false);
  if (!renovando) {
    renovando = (async () => {
      try {
        const r = await fetch(`${API}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: state.refreshToken }) });
        const rj = await r.json().catch(() => ({}));
        if (r.ok && rj.data?.accessToken) { salvarSessao(rj.data); return true; }
        return r.status === 401 ? false : null; // null = falha temporária (rede/servidor), mantém a sessão
      } catch {
        return null;
      } finally {
        renovando = null;
      }
    })();
  }
  return renovando;
}

function encerrarSessaoExpirada() {
  limparSessao();
  mostrarView('login');
  $('login-erro').textContent = 'Sua sessão expirou. Entre de novo.';
}

async function api(path, { method = 'GET', body, tentarRefresh = true, raw = false } = {}) {
  // Renova antes de vencer (menos de 60 s) para não disparar um 401 em cada chamada paralela.
  if (tentarRefresh && state.accessToken && state.refreshToken && !path.startsWith('/auth/') && tokenExpiraEm(state.accessToken) < 60000) {
    if ((await renovarSessao()) === false) { encerrarSessaoExpirada(); throw new Error('Sessão expirada. Entre de novo.'); }
  }
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (state.accessToken) headers.authorization = `Bearer ${state.accessToken}`;
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && tentarRefresh && state.refreshToken && !path.startsWith('/auth/')) {
    const ok = await renovarSessao();
    if (ok) return api(path, { method, body, tentarRefresh: false, raw });
    if (ok === false) encerrarSessaoExpirada();
    throw new Error(ok === false ? 'Sessão expirada. Entre de novo.' : 'Sem conexão com o servidor. Tentando de novo.');
  }
  if (raw) {
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error?.message || `Erro ${res.status}`);
    }
    return res; // arquivo: quem chamou lê o blob
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const e = json.error || {};
    const detalhes = Array.isArray(e.details) ? ` (${e.details.map((d) => `${d.path}: ${d.message}`).join('; ')})` : '';
    throw new Error((e.message || `Erro ${res.status}`) + detalhes);
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// Tema e menu lateral
// ---------------------------------------------------------------------------
function temaAtual() {
  return document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function aplicarTema(tema) {
  document.documentElement.dataset.theme = tema;
  cofre.set('aim.tema', tema);
  atualizarBotaoTema();
}
function atualizarBotaoTema() {
  const escuro = temaAtual() === 'dark';
  $('tema').setAttribute('aria-pressed', String(escuro));
  $('tema').title = escuro ? 'Mudar para o tema claro' : 'Mudar para o tema escuro';
  $('tema-rotulo').textContent = escuro ? 'Tema claro' : 'Tema escuro';
}
$('tema').addEventListener('click', () => aplicarTema(temaAtual() === 'dark' ? 'light' : 'dark'));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!cofre.get('aim.tema')) atualizarBotaoTema(); });

function aplicarMenu(recolhido) {
  document.body.classList.toggle('menu-recolhido', recolhido);
  cofre.set('aim.menu', recolhido ? 'recolhido' : 'aberto');
  const b = $('recolher');
  b.setAttribute('aria-expanded', String(!recolhido));
  b.title = recolhido ? 'Expandir menu' : 'Recolher menu';
  b.setAttribute('aria-label', b.title);
  // Gráficos dependem da largura disponível: redesenha depois da transição.
  if (DASHBOARDS.includes(state.view)) setTimeout(redesenharSeries, 220);
}
function alternarMenu() {
  aplicarMenu(!document.body.classList.contains('menu-recolhido'));
}
$('recolher').addEventListener('click', alternarMenu);
// Clicar em qualquer área livre do menu (marca, espaços) também recolhe/expande.
// Botões (abas, tema, sair) continuam com a própria ação. Em telas pequenas o menu vira barra e não recolhe.
$('topo').addEventListener('click', (e) => {
  if (e.target.closest('button, a, input, select')) return;
  if (getComputedStyle($('recolher')).display === 'none') return;
  alternarMenu();
});

// ---------------------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------------------
function mostrarView(nome) {
  state.view = nome;
  const logado = nome !== 'login';
  $('topo').hidden = !logado;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== nome;
  document.querySelectorAll('.aba[data-view]').forEach((b) => b.setAttribute('aria-current', b.dataset.view === nome ? 'page' : 'false'));
  Object.values(state.timers).forEach(clearInterval);
  state.timers = {};
  if (nome === 'leads') {
    trocarPainel('lista'); // no celular, a aba Leads sempre abre pela lista
    carregarLeads();
    state.timers.leads = setInterval(carregarLeads, 4000);
    if (state.leadId) state.timers.lead = setInterval(carregarLead, 2000);
  } else if (nome === 'imoveis') {
    carregarImoveis();
  } else if (DASHBOARDS.includes(nome)) {
    carregarDashboard(nome);
  }
}

document.querySelectorAll('.aba[data-view]').forEach((b) => b.addEventListener('click', () => mostrarView(b.dataset.view)));
$('sair').addEventListener('click', async () => {
  try { if (state.refreshToken) await api('/auth/logout', { method: 'POST', body: { refreshToken: state.refreshToken }, tentarRefresh: false }); } catch { /* sessão já inválida */ }
  limparSessao();
  cofre.set('aim.semAuto', '1'); // saiu de propósito: não entrar sozinho de novo até pedir
  mostrarView('login');
  $('login-dev').hidden = cofre.get('aim.devLogin') !== '1';
});

/** Ambiente local com DEV_AUTO_LOGIN: entra como o admin do seed sem pedir senha. */
async function entrarAutomatico() {
  try {
    const data = await api('/dev/login', { method: 'POST', tentarRefresh: false });
    salvarSessao(data);
    cofre.set('aim.devLogin', '1');
    cofre.del('aim.semAuto');
    await iniciar();
    return true;
  } catch {
    return false; // produção (rota não existe) ou seed ausente: cai na tela de entrada
  }
}
$('login-dev').addEventListener('click', async () => {
  $('login-erro').textContent = '';
  if (!(await entrarAutomatico())) $('login-erro').textContent = 'Entrada automática indisponível. Confira DEV_AUTO_LOGIN e o seed.';
});

document.querySelectorAll('.painel-troca button').forEach((b) =>
  b.addEventListener('click', () => trocarPainel(b.dataset.pane))
);
function trocarPainel(nome) {
  $('view-leads').dataset.pane = nome;
  document.querySelectorAll('.painel-troca button').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.pane === nome)));
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------
$('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  $('login-erro').textContent = '';
  const botao = ev.target.querySelector('button[type=submit]');
  botao.disabled = true;
  try {
    const data = await api('/auth/login', { method: 'POST', body: { tenant: f.get('tenant').trim(), email: f.get('email').trim(), password: f.get('password') }, tentarRefresh: false });
    salvarSessao(data);
    cofre.del('aim.semAuto');
    await iniciar();
  } catch (err) {
    $('login-erro').textContent = err.message;
  } finally {
    botao.disabled = false;
  }
});

async function iniciar() {
  $('usuario-nome').textContent = state.user?.name || '';
  try {
    state.dev = await api('/dev/status');
  } catch {
    state.dev = null; // produção: sem simulador
  }
  const avisos = [];
  if (state.dev) {
    $('conta-nome').textContent = state.dev.tenant?.name || '';
    if (!state.dev.aiConfigured) avisos.push('A assistente não vai responder: preencha <code>ANTHROPIC_API_KEY</code> no .env e reinicie a API.');
    if (state.dev.waMock) avisos.push('Modo simulação: nenhuma mensagem sai para o WhatsApp de verdade.');
    if (state.dev.tenant && !state.dev.tenant.waConfigured) avisos.push('A conta não tem número de WhatsApp cadastrado (rode o seed).');
  }
  $('aviso').innerHTML = avisos.join(' ');
  $('aviso').hidden = avisos.length === 0;
  $('novo-simulado').hidden = !state.dev;
  $('enviar-lead').hidden = !state.dev;
  $('conversa-vazia-dica').textContent = state.dev ? 'Ou use "Simular um lead novo" para conversar como se fosse um cliente chegando pelo anúncio.' : '';
  mostrarView('leads');
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
$('filtro-classificacao').addEventListener('change', (ev) => { state.filtro = ev.target.value; carregarLeads(); });

async function carregarLeads() {
  try {
    const q = state.filtro ? `?classification=${state.filtro}&limit=100` : '?limit=100';
    const data = await api(`/leads${q}`);
    const ordem = { quente: 0, morno: 1, indefinido: 2, frio: 3 };
    state.leads = data.items.sort((a, b) => (ordem[a.classification] - ordem[b.classification]) || (new Date(b.lastInboundAt || b.createdAt) - new Date(a.lastInboundAt || a.createdAt)));
    renderLeads();
    // Lead simulado acabou de ser criado no banco: passa a acompanhar ele.
    if (state.simulado) {
      const criado = state.leads.find((l) => l.phone === state.simulado.phone);
      if (criado) { state.simulado = null; selecionarLead(criado.id); }
    }
  } catch (err) {
    $('leads').innerHTML = `<li class="lista-vazia">${esc(err.message)}</li>`;
  }
}

function renderLeads() {
  const ul = $('leads');
  if (!state.leads.length && !state.simulado) {
    ul.innerHTML = `<li class="lista-vazia">${state.filtro ? 'Nenhum lead com essa classificação.' : 'Nenhum lead ainda. Quando alguém clicar no link do anúncio e mandar mensagem, ele aparece aqui.'}</li>`;
    return;
  }
  const itens = state.leads.map((l) => `
    <li><button type="button" class="lead-item" data-id="${l.id}" data-classe="${l.classification}" aria-current="${l.id === state.leadId}">
      <span class="barra" aria-hidden="true"></span>
      <span class="nome">${esc(l.name || telefone(l.phone))}</span>
      <span class="quando">${l.lastInboundAt ? dataHora(l.lastInboundAt) : ''}</span>
      <span class="detalhe">${esc(CLASSE[l.classification])} · ${esc(STATUS[l.status] || l.status)}${l.property ? ` · ${esc(l.property.code)}` : ''}</span>
    </button></li>`);
  if (state.simulado) {
    itens.unshift(`<li><button type="button" class="lead-item" data-id="simulado" data-classe="indefinido" aria-current="${state.leadId === null}">
      <span class="barra" aria-hidden="true"></span>
      <span class="nome">${esc(state.simulado.name)}</span><span class="quando">agora</span>
      <span class="detalhe">Simulação · ainda não mandou mensagem</span>
    </button></li>`);
  }
  ul.innerHTML = itens.join('');
}

$('leads').addEventListener('click', (ev) => {
  const b = ev.target.closest('.lead-item');
  if (!b) return;
  if (b.dataset.id === 'simulado') { state.leadId = null; state.lead = null; renderLeads(); renderConversa(); trocarPainel('conversa'); return; }
  selecionarLead(b.dataset.id);
});

async function selecionarLead(id) {
  state.leadId = id;
  clearInterval(state.timers.lead);
  state.timers.lead = setInterval(carregarLead, 2000);
  await carregarLead();
  renderLeads();
  trocarPainel('conversa');
}

async function carregarLead() {
  if (!state.leadId) return;
  try {
    const lead = await api(`/leads/${state.leadId}`);
    const antes = state.lead;
    state.lead = lead;
    renderConversa();
    renderFicha(antes);
  } catch (err) {
    $('mensagem-erro').textContent = err.message;
  }
}

$('novo-simulado').addEventListener('click', () => {
  const n = Math.floor(Math.random() * 90000000 + 10000000);
  const nomes = ['Ana Souza', 'Bruno Lima', 'Carla Mendes', 'Diego Rocha', 'Elaine Costa', 'Fábio Nunes', 'Gabriela Reis', 'Henrique Alves'];
  state.simulado = { phone: `55119${n}`, name: nomes[Math.floor(Math.random() * nomes.length)] };
  state.leadId = null;
  state.lead = null;
  renderLeads();
  renderConversa();
  trocarPainel('conversa');
  const p = state.properties[0];
  $('texto-mensagem').value = p ? `Olá! Tenho interesse no imóvel #${p.code} (${p.title}).` : 'Olá! Vi o anúncio e tenho interesse.';
  $('texto-mensagem').focus();
});

function renderConversa() {
  const temAlgo = state.lead || state.simulado;
  $('conversa-vazia').hidden = Boolean(temAlgo);
  $('conversa-corpo').hidden = !temAlgo;
  if (!temAlgo) return;

  if (state.lead) {
    const l = state.lead;
    $('lead-nome').textContent = l.name || telefone(l.phone);
    $('lead-sub').textContent = [telefone(l.phone), l.property ? `${l.property.code} · ${l.property.title}` : 'Sem imóvel vinculado', STATUS[l.status] || l.status].join(' · ');
    $('bot-toggle').hidden = false;
    $('bot-toggle').textContent = l.botActive ? 'Pausar assistente' : 'Religar assistente';
    $('bot-toggle').disabled = l.status === 'opt_out';
    const ol = $('mensagens');
    const noFim = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
    ol.innerHTML = l.messages.map((m) => {
      const quem = m.direction === 'in' ? (l.name || 'Lead') : m.author === 'bot' ? (state.dev?.tenant?.assistantName || 'Assistente') : m.author === 'human' ? 'Corretor' : 'Sistema';
      return `<li class="msg ${m.direction} ${m.author}"><span class="quem">${esc(quem)}</span>${esc(m.text)}<time datetime="${m.createdAt}">${hora(m.createdAt)}</time></li>`;
    }).join('');
    if (noFim) ol.scrollTop = ol.scrollHeight;
    const ultima = l.messages[l.messages.length - 1];
    const esperando = state.aguardandoBotDesde && Date.now() - state.aguardandoBotDesde < 45000 && ultima && ultima.direction === 'in' && l.botActive;
    if (ultima && ultima.direction === 'out') state.aguardandoBotDesde = 0;
    $('digitando').hidden = !esperando;
    $('enviar-lead').disabled = l.status === 'opt_out';
    $('enviar-corretor').disabled = l.status === 'opt_out';
  } else {
    $('lead-nome').textContent = state.simulado.name;
    $('lead-sub').textContent = `${telefone(state.simulado.phone)} · simulação, ainda sem mensagem`;
    $('bot-toggle').hidden = true;
    $('mensagens').innerHTML = '';
    $('digitando').hidden = true;
    $('enviar-lead').disabled = false;
    $('enviar-corretor').disabled = true;
  }
}

$('bot-toggle').addEventListener('click', async () => {
  if (!state.lead) return;
  try {
    await api(`/leads/${state.lead.id}`, { method: 'PATCH', body: { botActive: !state.lead.botActive } });
    await carregarLead();
  } catch (err) { $('mensagem-erro').textContent = err.message; }
});

let comoEnviar = 'corretor';
$('form-mensagem').querySelectorAll('button[type=submit]').forEach((b) => b.addEventListener('click', () => { comoEnviar = b.dataset.como; }));
$('form-mensagem').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const texto = $('texto-mensagem').value.trim();
  if (!texto) return;
  $('mensagem-erro').textContent = '';
  const botoes = ev.target.querySelectorAll('button');
  botoes.forEach((b) => { b.disabled = true; });
  try {
    if (comoEnviar === 'lead') {
      const alvo = state.lead ? { phone: state.lead.phone, name: state.lead.name || undefined } : state.simulado;
      await api('/dev/inbound', { method: 'POST', body: { phone: alvo.phone, name: alvo.name, text: texto } });
      state.aguardandoBotDesde = Date.now();
    } else {
      await api(`/leads/${state.lead.id}/messages`, { method: 'POST', body: { text: texto } });
    }
    $('texto-mensagem').value = '';
    if (state.lead) await carregarLead(); else await carregarLeads();
  } catch (err) {
    $('mensagem-erro').textContent = err.message;
  } finally {
    botoes.forEach((b) => { b.disabled = false; });
    renderConversa();
  }
});
$('texto-mensagem').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    comoEnviar = state.dev && (!state.lead || state.lead.botActive) ? 'lead' : 'corretor';
    $('form-mensagem').requestSubmit();
  }
});

function renderFicha(antes) {
  const l = state.lead;
  $('ficha-vazia').hidden = Boolean(l);
  $('ficha-corpo').hidden = !l;
  if (!l) return;

  const carimbo = $('carimbo');
  if (carimbo.dataset.classe !== l.classification) {
    carimbo.dataset.classe = l.classification;
    carimbo.textContent = CLASSE[l.classification];
    if (antes && antes.id === l.id) { carimbo.style.animation = 'none'; void carimbo.offsetWidth; carimbo.style.animation = ''; }
  }
  $('pontuacao-preenchida').style.width = `${Math.max(0, Math.min(100, l.score || 0))}%`;
  $('pontuacao-valor').textContent = l.score || 0;

  const q = l.qualification;
  const linhas = [
    ['Renda mensal', q.monthlyIncomeCents === null ? null : reais(q.monthlyIncomeCents)],
    ['Garantia', q.guarantee === null ? null : GARANTIA[q.guarantee] || q.guarantee],
    ['Moradores', q.occupants],
    ['Tem pet', q.hasPets === null ? null : q.hasPets ? 'Sim' : 'Não'],
    ['Quer se mudar em', q.moveInDays === null ? null : `${q.moveInDays} dias`],
    ['Quer visitar', q.wantsVisit === null ? null : q.wantsVisit ? 'Sim' : 'Não'],
    ['Preferência de visita', l.visitPreference],
    ['Imóvel', l.property ? `${l.property.code}` : null],
  ];
  $('fatos').innerHTML = linhas.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="${v === null || v === undefined ? 'pendente' : ''}">${v === null || v === undefined ? 'ainda não disse' : esc(v)}</dd></div>`).join('');

  $('motivos-bloco').hidden = !l.disqualifyReasons.length;
  $('motivos').innerHTML = l.disqualifyReasons.map((r) => `<li>${esc(MOTIVO[r] || r)}</li>`).join('');

  $('resumo-bloco').hidden = !l.handoffSummary;
  $('resumo-texto').textContent = l.handoffSummary || '';
  const duvidas = l.openQuestions || [];
  $('duvidas-bloco').hidden = !duvidas.length;
  $('duvidas').innerHTML = duvidas.map((d) => `<li>${esc(d)}</li>`).join('');

  const sel = $('lead-status');
  if (document.activeElement !== sel) {
    sel.value = ['em_atendimento', 'transferido', 'visita_agendada', 'descartado'].includes(l.status) ? l.status : 'em_atendimento';
    sel.disabled = l.status === 'opt_out';
  }
  $('lead-handoff').textContent = l.handoffAt ? `Transferido em ${dataHora(l.handoffAt)}${l.handoffReason ? `: ${l.handoffReason}` : ''}` : (l.status === 'opt_out' ? 'O lead pediu para não receber mais mensagens.' : '');
}
$('lead-status').addEventListener('change', async (ev) => {
  if (!state.lead) return;
  try { await api(`/leads/${state.lead.id}`, { method: 'PATCH', body: { status: ev.target.value } }); await carregarLead(); await carregarLeads(); }
  catch (err) { $('mensagem-erro').textContent = err.message; }
});

// ---------------------------------------------------------------------------
// Imóveis
// ---------------------------------------------------------------------------
async function carregarImoveis() {
  try {
    state.properties = await api('/properties');
    renderImoveis();
  } catch (err) {
    $('imoveis').innerHTML = `<li class="lista-vazia">${esc(err.message)}</li>`;
  }
}
function renderImoveis() {
  const ul = $('imoveis');
  if (!state.properties.length) { ul.innerHTML = '<li class="lista-vazia">Nenhum imóvel cadastrado. Cadastre o primeiro para gerar o link do anúncio.</li>'; return; }
  ul.innerHTML = state.properties.map((p) => `
    <li><button type="button" class="imovel-item" data-id="${p.id}" aria-current="${p.id === state.propertyId}">
      <span class="codigo">${esc(p.code)}${p.isActive ? '' : ' <span class="inativo">(inativo)</span>'}</span>
      <span>${esc(p.title)}</span>
      <span class="sutil">${esc(p.dealType === 'venda' ? 'Venda' : 'Aluguel')} · ${reais(p.priceCents)}${p.feesCents ? ` + ${reais(p.feesCents)}` : ''}</span>
    </button></li>`).join('');
}
$('imoveis').addEventListener('click', (ev) => {
  const b = ev.target.closest('.imovel-item');
  if (b) abrirImovel(b.dataset.id);
});
$('novo-imovel').addEventListener('click', () => abrirImovel(null));

async function abrirImovel(id) {
  state.propertyId = id;
  renderImoveis();
  const form = $('form-imovel');
  form.hidden = false;
  $('imovel-vazio').hidden = true;
  $('imovel-erro').textContent = '';
  $('imovel-ok').textContent = '';
  form.reset();
  form.querySelectorAll('[name=acceptedGuarantees]').forEach((c) => { c.checked = false; });
  const p = id ? state.properties.find((x) => x.id === id) : null;
  $('imovel-titulo-form').textContent = p ? `${p.code} · ${p.title}` : 'Novo imóvel';
  $('links').hidden = !p;
  $('imovel-duvidas').hidden = true;
  if (p) {
    form.code.value = p.code; form.title.value = p.title; form.dealType.value = p.dealType;
    form.locationSummary.value = p.locationSummary || ''; form.price.value = (p.priceCents / 100).toFixed(2);
    form.fees.value = ((p.feesCents || 0) / 100).toFixed(2); form.bedrooms.value = p.bedrooms ?? '';
    form.maxOccupants.value = p.maxOccupants ?? ''; form.allowsPets.value = p.allowsPets === null ? '' : String(p.allowsPets);
    form.availableFrom.value = p.availableFrom || ''; form.description.value = p.description || '';
    form.extraInfo.value = p.extraInfo || ''; form.isActive.checked = p.isActive;
    (p.acceptedGuarantees || []).forEach((g) => { const c = form.querySelector(`[name=acceptedGuarantees][value=${g}]`); if (c) c.checked = true; });
    try {
      const links = await api(`/properties/${p.id}/links?src=marketplace`);
      $('link-rastreado').value = links.trackedLink; $('abrir-rastreado').href = links.trackedLink; $('link-wa').value = links.waLink;
    } catch (err) {
      $('link-rastreado').value = err.message; $('link-wa').value = ''; $('abrir-rastreado').removeAttribute('href');
    }
    try {
      const duvidas = await api(`/properties/${p.id}/open-questions`);
      $('imovel-duvidas').hidden = !duvidas.length;
      $('imovel-duvidas-lista').innerHTML = duvidas
        .map((d) => `<li>${esc(d.question)} <span class="sutil">(${d.leads} ${d.leads === 1 ? 'lead' : 'leads'})</span></li>`)
        .join('');
    } catch {
      $('imovel-duvidas').hidden = true;
    }
  }
}

$('form-imovel').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const num = (v) => (v === '' ? null : Number(v));
  const body = {
    code: form.code.value.trim().toUpperCase(),
    title: form.title.value.trim(),
    dealType: form.dealType.value,
    locationSummary: form.locationSummary.value.trim(),
    priceCents: Math.round(Number(form.price.value) * 100),
    feesCents: Math.round(Number(form.fees.value || 0) * 100),
    bedrooms: num(form.bedrooms.value),
    maxOccupants: num(form.maxOccupants.value),
    allowsPets: form.allowsPets.value === '' ? null : form.allowsPets.value === 'true',
    availableFrom: form.availableFrom.value || null,
    acceptedGuarantees: [...form.querySelectorAll('[name=acceptedGuarantees]:checked')].map((c) => c.value),
    description: form.description.value.trim(),
    extraInfo: form.extraInfo.value.trim(),
    isActive: form.isActive.checked,
  };
  $('imovel-erro').textContent = '';
  $('salvar-imovel').disabled = true;
  try {
    const salvo = state.propertyId
      ? await api(`/properties/${state.propertyId}`, { method: 'PATCH', body })
      : await api('/properties', { method: 'POST', body });
    $('imovel-ok').textContent = 'Imóvel salvo.';
    await carregarImoveis();
    await abrirImovel(salvo.id);
    $('imovel-ok').textContent = 'Imóvel salvo.';
  } catch (err) {
    $('imovel-erro').textContent = err.message;
  } finally {
    $('salvar-imovel').disabled = false;
  }
});

document.querySelectorAll('[data-copiar]').forEach((b) => b.addEventListener('click', async () => {
  const v = $(b.dataset.copiar).value;
  try { await navigator.clipboard.writeText(v); b.textContent = 'Copiado'; setTimeout(() => { b.textContent = 'Copiar'; }, 1500); }
  catch { $(b.dataset.copiar).select(); }
}));

// ---------------------------------------------------------------------------
// Dashboards (Funil, Anúncios, Atendimento): mesmo filtro de período e imóvel
// ---------------------------------------------------------------------------
const dash = { dias: 30, propertyId: '', dados: null, series: [], resizeTimer: null };

const pct = (v, base) => (base > 0 ? Math.round((v / base) * 100) : null);
const diaCurto = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const diaLongo = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
function fmtMin(m) {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h} h ${r} min`;
}
function niceTicks(max, n = 4) {
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const step = [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) || mag * 10;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const out = [];
  for (let v = 0; v <= top; v += step) out.push(v);
  return out;
}
function barras(items, cor) {
  if (!items.length) return '';
  const top = Math.max(1, ...items.map((i) => i.valor));
  return `<ol class="barras">${items.map((i) => `<li><span class="rotulo">${esc(i.nome)}</span><span class="trilho"><span class="preench ${cor}" style="width:${(i.valor / top) * 100}%"></span></span><span class="num">${i.valor}</span></li>`).join('')}</ol>`;
}
const tile = (t) => `<div class="tile${t.alerta ? ' alerta' : ''}"><span class="rotulo">${esc(t.rotulo)}</span><span class="valor">${esc(t.valor)}</span><span class="sub">${esc(t.sub)}</span></div>`;

window.addEventListener('resize', () => {
  if (!DASHBOARDS.includes(state.view)) return;
  clearTimeout(dash.resizeTimer);
  dash.resizeTimer = setTimeout(redesenharSeries, 150);
});
function redesenharSeries() {
  for (const s of dash.series) if (s.grafico.isConnected && !s.grafico.closest('[hidden]')) renderSerie(s);
}

function periodoQuery() {
  const p = new URLSearchParams();
  if (dash.propertyId) p.set('propertyId', dash.propertyId);
  if (dash.dias > 0) {
    const inicio = new Date();
    inicio.setHours(0, 0, 0, 0);
    inicio.setDate(inicio.getDate() - (dash.dias - 1));
    p.set('from', inicio.toISOString());
    p.set('to', new Date().toISOString());
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Linha de filtros (período, imóvel, exportação), igual em todos os dashboards. */
function montarFiltros(view) {
  const box = view.querySelector('.filtros-dash');
  box.innerHTML = `
    <div class="periodo" role="group" aria-label="Período">${[7, 30, 90, 0].map((d) => `<button type="button" data-dias="${d}" aria-pressed="${d === dash.dias}">${d ? `${d} dias` : 'Tudo'}</button>`).join('')}</div>
    <select class="filtro-imovel" aria-label="Filtrar por imóvel"><option value="">Todos os imóveis</option>${state.properties.map((p) => `<option value="${p.id}">${esc(p.code)} · ${esc(p.title)}</option>`).join('')}</select>
    <span class="sutil periodo-texto">${dash.dias > 0 ? `Últimos ${dash.dias} dias` : 'Todo o período (gráficos: últimos 90 dias)'}</span>
    <div class="exportar">
      <button type="button" class="botao secundario" data-formato="xlsx" title="Baixa os leads do período e imóvel filtrados em Excel">Exportar Excel</button>
      <button type="button" class="botao secundario" data-formato="csv" title="Baixa os leads do período e imóvel filtrados em CSV">Exportar CSV</button>
    </div>`;
  box.querySelectorAll('.periodo button').forEach((b) => b.addEventListener('click', () => { dash.dias = Number(b.dataset.dias); carregarDashboard(state.view); }));
  const sel = box.querySelector('.filtro-imovel');
  sel.value = dash.propertyId;
  sel.addEventListener('change', () => { dash.propertyId = sel.value; carregarDashboard(state.view); });
  box.querySelectorAll('.exportar button').forEach((b) => b.addEventListener('click', () => exportarLeads(b, view)));
}

async function carregarDashboard(nome) {
  const view = $(`view-${nome}`);
  const cont = view.querySelector('.dash-conteudo');
  const erro = view.querySelector('.erro');
  cont.classList.add('recarregando');
  erro.textContent = '';
  try {
    if (!state.properties.length) state.properties = await api('/properties');
    montarFiltros(view);
    dash.dados = await api(`/metrics/overview${periodoQuery()}`);
    dash.series = [];
    ({ funil: renderFunil, anuncios: renderAnuncios, atendimento: renderAtendimento })[nome](view, dash.dados);
  } catch (err) {
    erro.textContent = err.message;
  } finally {
    cont.classList.remove('recarregando');
  }
}

// ---- Funil ----
function renderFunil(view, d) {
  const f = d.funnel;
  const qualificados = f.quentes + f.mornos;
  view.querySelector('.tiles').innerHTML = [
    { rotulo: 'Conversas iniciadas', valor: f.leads, sub: `${f.clicks} ${f.clicks === 1 ? 'clique' : 'cliques'} no anúncio` },
    { rotulo: 'Qualificados', valor: qualificados, sub: pct(qualificados, f.leads) === null ? 'quentes e mornos' : `${pct(qualificados, f.leads)}% das conversas` },
    { rotulo: 'Tempo até transferir', valor: fmtMin(d.handoff.medianMinutes), sub: d.handoff.count ? `mediana de ${d.handoff.count} ${d.handoff.count === 1 ? 'transferência' : 'transferências'}` : 'nenhuma transferência no período' },
    { rotulo: 'Aguardando o corretor', valor: d.awaiting.length, sub: 'transferidos sem resposta humana', alerta: d.awaiting.length > 0 },
  ].map(tile).join('');

  const etapas = [
    { nome: 'Cliques no anúncio', valor: f.clicks },
    { nome: 'Conversas iniciadas', valor: f.leads, base: f.clicks, baseNome: 'dos cliques' },
    { nome: 'Qualificados (quente ou morno)', valor: qualificados, base: f.leads, baseNome: 'das conversas' },
    { nome: 'Transferidos ao corretor', valor: f.transferidos, base: f.leads, baseNome: 'das conversas' },
    { nome: 'Visitas agendadas', valor: f.visitas, base: f.transferidos, baseNome: 'dos transferidos' },
  ];
  const max = Math.max(1, ...etapas.map((e) => e.valor));
  view.querySelector('.etapas').innerHTML = etapas.map((e) => {
    const taxa = e.base === undefined ? null : pct(e.valor, e.base);
    return `<li class="etapa"><span>${esc(e.nome)}${taxa !== null ? `<span class="taxa">${taxa}% ${e.baseNome}</span>` : ''}</span><div class="barra"><span class="c1" style="width:${(e.valor / max) * 100}%"></span></div><span class="valor">${e.valor}</span></li>`;
  }).join('');
  view.querySelector('.temperaturas').innerHTML = [['quente', f.quentes], ['morno', f.mornos], ['frio', f.frios], ['indefinido', f.indefinidos]]
    .map(([c, n]) => `<div class="temperatura" data-classe="${c}"><strong>${n}</strong><span>${esc(CLASSE[c])}</span></div>`).join('');

  serie(view, 'cliques', d.timeline.days, [{ key: 'clicks', nome: 'cliques', cls: 'c1' }, { key: 'leads', nome: 'conversas', cls: 'c2' }], 'Cliques e conversas por dia');
  renderMotivos(view, d.disqualify);
  renderFila(view, d.awaiting);
}

// ---- Anúncios ----
function renderAnuncios(view, d) {
  const f = d.funnel;
  const props = d.byProperty;
  const maisConversas = [...props].sort((a, b) => b.leads - a.leads)[0];
  const origemTop = d.bySource.clicks[0];
  view.querySelector('.tiles').innerHTML = [
    { rotulo: 'Cliques no anúncio', valor: f.clicks, sub: `${d.bySource.clicks.length} ${d.bySource.clicks.length === 1 ? 'origem' : 'origens'} de link` },
    { rotulo: 'Conversas iniciadas', valor: f.leads, sub: pct(f.leads, f.clicks) === null ? 'sem cliques no período' : `${pct(f.leads, f.clicks)}% dos cliques` },
    { rotulo: 'Imóvel com mais conversas', valor: maisConversas && maisConversas.leads ? maisConversas.code : '—', sub: maisConversas && maisConversas.leads ? `${maisConversas.leads} ${maisConversas.leads === 1 ? 'conversa' : 'conversas'}` : 'nenhuma conversa no período' },
    { rotulo: 'Origem com mais cliques', valor: origemTop ? ORIGEM[origemTop.source] || origemTop.source : '—', sub: origemTop ? `${origemTop.n} ${origemTop.n === 1 ? 'clique' : 'cliques'}` : 'use ?src= no link rastreado' },
  ].map(tile).join('');

  const ativos = props.filter((p) => p.clicks || p.leads || p.isActive);
  const top = Math.max(1, ...ativos.map((p) => Math.max(p.clicks, p.leads)));
  view.querySelector('.barras-duplas').innerHTML = ativos.length
    ? `<ol class="barras duplas">${ativos.map((p) => `<li>
        <span class="rotulo"><span class="codigo">${esc(p.code)}</span><span class="sutil">${esc(p.title)}</span></span>
        <span class="trilhos"><span class="trilho"><span class="preench c1" style="width:${(p.clicks / top) * 100}%"></span></span><span class="trilho"><span class="preench c2" style="width:${(p.leads / top) * 100}%"></span></span></span>
        <span class="nums"><span>${p.clicks}</span><span>${p.leads}</span></span>
      </li>`).join('')}</ol>`
    : '<p class="vazio">Nenhum imóvel cadastrado.</p>';

  const comLeads = props.filter((p) => p.leads);
  view.querySelector('.empilhadas').innerHTML = comLeads.length
    ? `<ol class="barras empilhadas-lista">${comLeads.map((p) => {
        const partes = [['quente', p.quentes], ['morno', p.mornos], ['frio', p.frios], ['indefinido', p.indefinidos]].filter(([, n]) => n > 0);
        return `<li>
          <span class="rotulo"><span class="codigo">${esc(p.code)}</span></span>
          <span class="trilho empilhado" title="${partes.map(([c, n]) => `${n} ${CLASSE[c].toLowerCase()}`).join(', ')}">${partes.map(([c, n]) => `<span class="seg t-${c}" style="width:${(n / p.leads) * 100}%"></span>`).join('')}</span>
          <span class="num">${p.leads}</span>
          <span class="detalhe-temp">${partes.map(([c, n]) => `${n} ${CLASSE[c].toLowerCase()}`).join(' · ')}</span>
        </li>`;
      }).join('')}</ol>`
    : '<p class="vazio">Nenhuma conversa no período.</p>';

  renderPorImovel(view, props);
  renderOrigem(view, d.bySource);
}

// ---- Atendimento ----
function renderAtendimento(view, d) {
  const m = d.messages;
  view.querySelector('.tiles').innerHTML = [
    { rotulo: 'Mensagens dos leads', valor: m.totals.lead, sub: m.leads ? `${(m.totals.lead / m.leads).toFixed(1).replace('.', ',')} por conversa` : 'nenhuma conversa no período' },
    { rotulo: 'Respostas da assistente', valor: m.totals.bot, sub: `${m.totals.system} ${m.totals.system === 1 ? 'aviso automático' : 'avisos automáticos'}` },
    { rotulo: 'Respostas do corretor', valor: m.totals.human, sub: 'enviadas pelo painel' },
    { rotulo: 'Resolvidos só pela assistente', valor: m.botOnlyRate === null ? '—' : `${String(m.botOnlyRate).replace('.', ',')}%`, sub: `${m.botOnly} de ${m.leads} ${m.leads === 1 ? 'conversa' : 'conversas'} sem resposta humana` },
  ].map(tile).join('');

  serie(view, 'mensagens', m.byDay, [{ key: 'lead', nome: 'dos leads', cls: 'c1' }, { key: 'bot', nome: 'da assistente', cls: 'c2' }, { key: 'human', nome: 'do corretor', cls: 'c3' }], 'Mensagens por dia');

  const top = d.openQuestionsTop;
  view.querySelector('.duvidas-top').innerHTML = top.length
    ? `<ol class="duvidas-lista">${top.map((q) => `<li><span>${esc(q.question)}</span><span class="sutil">${q.propertyCode ? `${esc(q.propertyCode)} · ` : ''}${q.leads} ${q.leads === 1 ? 'lead' : 'leads'}</span></li>`).join('')}</ol><p class="sutil">Responda a elas no cadastro do imóvel para a assistente atender sem transferir.</p>`
    : '<p class="vazio">Nenhuma dúvida sem resposta no período.</p>';
  renderMotivos(view, d.disqualify);
  renderFila(view, d.awaiting);
}

// ---- Componentes compartilhados dos dashboards ----
function serie(view, nome, days, series, rotulo) {
  const s = { grafico: view.querySelector(`.grafico[data-serie="${nome}"]`), tabela: view.querySelector(`.grafico[data-serie="${nome}"]`).parentElement.querySelector('.serie-tabela'), days, series, rotulo };
  dash.series.push(s);
  renderSerie(s);
}

/** Colunas agrupadas por dia (até 3 séries), com tooltip por dia (mouse e teclado) e tabela gêmea. */
function renderSerie({ grafico: wrap, tabela, days, series, rotulo }) {
  if (!days.length) { wrap.innerHTML = '<p class="vazio">Sem dados no período.</p>'; tabela.innerHTML = ''; return; }
  const W = Math.max(320, wrap.clientWidth || 800);
  const m = { top: 12, right: 12, bottom: 28, left: 36 };
  const H = 240;
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const max = Math.max(1, ...days.map((d) => Math.max(...series.map((s) => d[s.key] || 0))));
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1];
  const y = (v) => m.top + ph - (v / yMax) * ph;
  const base = m.top + ph;
  const slot = pw / days.length;
  const gap = 2;
  const n = series.length;
  const bw = Math.max(2, Math.min(12, (slot - gap * (n - 1)) * 0.8 / n));
  const grupo = bw * n + gap * (n - 1);
  const coluna = (x, v, cls) => {
    if (v <= 0) return '';
    const top = y(v);
    const r = Math.min(4, bw / 2, base - top);
    return `<path class="${cls}" d="M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z"/>`;
  };
  const cada = Math.max(1, Math.ceil(days.length / 6));
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(rotulo)}">`;
  svg += ticks.map((t) => `<line class="grade" x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}"/><text class="eixo" x="${m.left - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('');
  svg += days.map((d, i) => {
    const x0 = m.left + i * slot + (slot - grupo) / 2;
    const cx = m.left + i * slot + slot / 2;
    const marca = i % cada === 0 && i <= days.length - cada / 2 ? `<text class="eixo" x="${cx}" y="${H - 8}" text-anchor="middle">${diaCurto(d.date)}</text>` : '';
    const cols = series.map((s, k) => coluna(x0 + k * (bw + gap), d[s.key] || 0, s.cls)).join('');
    const aria = `${diaCurto(d.date)}: ${series.map((s) => `${d[s.key] || 0} ${s.nome}`).join(', ')}`;
    return `<g class="dia" data-i="${i}" tabindex="0" aria-label="${esc(aria)}">${cols}<rect class="alvo" x="${m.left + i * slot}" y="${m.top}" width="${slot}" height="${ph}"/></g>${marca}`;
  }).join('');
  svg += '</svg><div class="tooltip" hidden></div>';
  wrap.innerHTML = svg;

  const tip = wrap.querySelector('.tooltip');
  const mostrar = (g) => {
    const d = days[Number(g.dataset.i)];
    tip.replaceChildren();
    const titulo = document.createElement('strong');
    titulo.textContent = diaLongo(d.date);
    tip.appendChild(titulo);
    for (const s of series) {
      const linha = document.createElement('span');
      linha.className = 'linha';
      const chave = document.createElement('i');
      chave.className = `chave ${s.cls}`;
      const num = document.createElement('b');
      num.textContent = d[s.key] || 0;
      linha.append(chave, num, document.createTextNode(` ${s.nome}`));
      tip.appendChild(linha);
    }
    tip.hidden = false;
    const r = g.querySelector('.alvo').getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const left = r.left - wr.left + r.width / 2 - tip.offsetWidth / 2;
    tip.style.left = `${Math.max(0, Math.min(left, wr.width - tip.offsetWidth))}px`;
  };
  const esconder = () => { tip.hidden = true; };
  wrap.querySelectorAll('.dia').forEach((g) => {
    g.addEventListener('pointerenter', () => mostrar(g));
    g.addEventListener('focus', () => mostrar(g));
    g.addEventListener('pointerleave', esconder);
    g.addEventListener('blur', esconder);
  });

  const comDados = days.filter((d) => series.some((s) => d[s.key]));
  tabela.innerHTML = comDados.length
    ? `<table class="tabela"><thead><tr><th>Dia</th>${series.map((s) => `<th>${esc(s.nome)}</th>`).join('')}</tr></thead><tbody>${comDados.map((d) => `<tr><td>${esc(diaLongo(d.date))}</td>${series.map((s) => `<td>${d[s.key] || 0}</td>`).join('')}</tr>`).join('')}</tbody></table><p class="sutil">Dias sem registros foram omitidos.</p>`
    : '<p class="vazio">Nenhum registro nesses dias.</p>';
}

function renderPorImovel(view, rows) {
  const t = view.querySelector('.por-imovel');
  if (!rows.length) { t.innerHTML = '<tbody><tr><td class="vazio">Nenhum imóvel cadastrado.</td></tr></tbody>'; return; }
  t.innerHTML = `<thead><tr><th>Imóvel</th><th>Cliques</th><th>Conversas</th><th>Quentes</th><th>Mornos</th><th>Frios</th><th>Transf.</th><th>Visitas</th><th>Clique → conversa</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="clicavel" data-id="${r.id}" aria-selected="${r.id === dash.propertyId}" tabindex="0">
      <td><span class="codigo">${esc(r.code)}</span>${r.isActive ? '' : ' <span class="sutil">(inativo)</span>'}<br><span class="sutil">${esc(r.title)}</span></td>
      <td>${r.clicks}</td><td>${r.leads}</td><td>${r.quentes}</td><td>${r.mornos}</td><td>${r.frios}</td><td>${r.transferidos}</td><td>${r.visitas}</td>
      <td>${r.taxaCliqueParaConversa === null ? '—' : `${String(r.taxaCliqueParaConversa).replace('.', ',')}%`}</td>
    </tr>`).join('')}</tbody>`;
  const escolher = (tr) => { dash.propertyId = tr.dataset.id === dash.propertyId ? '' : tr.dataset.id; carregarDashboard(state.view); };
  t.querySelectorAll('tr.clicavel').forEach((tr) => {
    tr.addEventListener('click', () => escolher(tr));
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); escolher(tr); } });
  });
}

function renderOrigem(view, s) {
  const cliques = s.clicks.map((r) => ({ nome: ORIGEM[r.source] || r.source, valor: r.n }));
  const conversas = s.leads.map((r) => ({ nome: ORIGEM[r.source] || r.source, valor: r.n }));
  view.querySelector('.por-origem').innerHTML =
    `<h3>Cliques por origem do link</h3>${cliques.length ? barras(cliques, 'c1') : '<p class="vazio">Nenhum clique no período. Use o link rastreado com ?src= no anúncio.</p>'}` +
    `<h3>Conversas por origem</h3>${conversas.length ? barras(conversas, 'c2') : '<p class="vazio">Nenhuma conversa no período.</p>'}`;
}

function renderMotivos(view, rows) {
  view.querySelector('.motivos-grafico').innerHTML = rows.length
    ? barras(rows.map((r) => ({ nome: MOTIVO[r.reason] || r.reason, valor: r.leads })), 'cf') + '<p class="sutil">Número de leads com cada motivo. Um lead pode ter mais de um.</p>'
    : '<p class="vazio">Nenhum lead desqualificado no período. Os imóveis estão batendo com quem chega.</p>';
}

function renderFila(view, rows) {
  const ul = view.querySelector('.fila');
  if (!rows.length) { ul.innerHTML = '<li class="vazio">Ninguém esperando. Todo lead transferido já recebeu resposta do corretor.</li>'; return; }
  ul.innerHTML = rows.map((a) => `<li data-classe="${a.classification}">
    <span class="barra" aria-hidden="true"></span>
    <span class="nome">${esc(a.name || telefone(a.phone))}</span>
    <button type="button" class="botao secundario" data-abrir="${a.id}">Abrir conversa</button>
    <span class="meta">${esc(CLASSE[a.classification])}${a.propertyCode ? ` · ${esc(a.propertyCode)}` : ''} · esperando há ${fmtMin(a.waitingMinutes)}</span>
  </li>`).join('');
  ul.querySelectorAll('[data-abrir]').forEach((b) => b.addEventListener('click', () => {
    mostrarView('leads');
    selecionarLead(b.dataset.abrir);
  }));
}

/** Baixa um arquivo autenticado da API (a sessão é renovada como em qualquer chamada). */
async function baixar(path, nomePadrao) {
  const res = await api(path, { raw: true });
  const cd = res.headers.get('content-disposition') || '';
  const nome = (/filename="([^"]+)"/.exec(cd) || [])[1] || nomePadrao;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportarLeads(btn, view) {
  const formato = btn.dataset.formato;
  const rotulo = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Gerando…';
  view.querySelector('.erro').textContent = '';
  try {
    const q = periodoQuery();
    await baixar(`/leads/export${q ? `${q}&` : '?'}format=${formato}`, `leads.${formato}`);
  } catch (err) {
    view.querySelector('.erro').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = rotulo;
  }
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
(async () => {
  const tema = cofre.get('aim.tema');
  if (tema) document.documentElement.dataset.theme = tema;
  atualizarBotaoTema();
  if (cofre.get('aim.menu') === 'recolhido') aplicarMenu(true);

  if (state.accessToken) {
    try { await iniciar(); return; } catch { limparSessao(); }
  }
  // Sem sessão: no ambiente local entra sozinho, a menos que a pessoa tenha clicado em "Sair".
  if (cofre.get('aim.semAuto') !== '1' && (await entrarAutomatico())) return;
  mostrarView('login');
  $('login-dev').hidden = cofre.get('aim.devLogin') !== '1';
})();
