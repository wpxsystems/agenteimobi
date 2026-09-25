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
  account: null, // { tenant, user, onboarding } de GET /account
  billing: null, // plano, uso e planos à venda (GET /billing)
  resetToken: null, // token do link "redefinir senha", lido da URL e apagado dela
  mensagem: '', // aviso de sucesso a mostrar na próxima tela (ex.: "E-mail confirmado")
  aguardandoBotDesde: 0,
  properties: [],
  propertyId: null,
  timers: {},
};

const DASHBOARDS = ['funil', 'anuncios', 'atendimento'];
const PUBLIC_VIEWS = ['login', 'cadastro', 'esqueci', 'redefinir'];
const VIEWS = [...PUBLIC_VIEWS, 'inicio', 'hoje', 'leads', 'agenda', 'imoveis', ...DASHBOARDS, 'plano'];

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
  const logado = !PUBLIC_VIEWS.includes(nome);
  $('topo').hidden = !logado;
  if (!logado) $('aviso').hidden = !state.mensagem;
  if (!logado && state.mensagem) { $('aviso').textContent = state.mensagem; state.mensagem = ''; }
  renderCaixaLocal(!logado || nome === 'inicio');
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== nome;
  document.querySelectorAll('.aba[data-view]').forEach((b) => b.setAttribute('aria-current', b.dataset.view === nome ? 'page' : 'false'));
  Object.values(state.timers).forEach(clearInterval);
  state.timers = {};
  if (nome === 'leads') {
    trocarPainel('lista'); // no celular, a aba Leads sempre abre pela lista
    carregarLeads();
    state.timers.leads = setInterval(carregarLeads, 4000);
    if (state.leadId) state.timers.lead = setInterval(carregarLead, 2000);
  } else if (nome === 'inicio') {
    carregarInicio();
  } else if (nome === 'plano') {
    carregarPlano();
  } else if (nome === 'hoje') {
    carregarHoje();
    state.timers.hoje = setInterval(carregarHoje, 60000);
  } else if (nome === 'agenda') {
    carregarAgenda();
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

// Links entre as telas públicas (entrar, criar conta, esqueci a senha).
document.querySelectorAll('[data-ir]').forEach((a) =>
  a.addEventListener('click', (ev) => {
    ev.preventDefault();
    document.querySelectorAll('.entrada-form .erro, .entrada-form .ok').forEach((p) => { p.textContent = ''; });
    mostrarView(a.dataset.ir);
  })
);

/** Enviar formulário com botão travado e erro no próprio formulário. */
async function enviarForm(form, fn) {
  const botao = form.querySelector('button[type=submit]');
  const erro = form.querySelector('.erro');
  erro.textContent = '';
  botao.disabled = true;
  try {
    await fn(new FormData(form));
  } catch (err) {
    erro.textContent = err.message;
  } finally {
    botao.disabled = false;
  }
}

// ---- Criar conta ----
/** "Imobiliária São João" -> "imobiliaria-sao-joao" */
function sugerirEndereco(nome) {
  return nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
}
const formCadastro = $('form-cadastro');
let enderecoEditado = false;
formCadastro.accountName.addEventListener('input', () => {
  if (!enderecoEditado) formCadastro.slug.value = sugerirEndereco(formCadastro.accountName.value);
});
formCadastro.slug.addEventListener('input', () => {
  enderecoEditado = formCadastro.slug.value !== '';
  formCadastro.slug.value = formCadastro.slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
});
formCadastro.addEventListener('submit', (ev) => {
  ev.preventDefault();
  enviarForm(formCadastro, async (f) => {
    const data = await api('/signup', {
      method: 'POST',
      tentarRefresh: false,
      body: {
        accountName: f.get('accountName').trim(),
        slug: f.get('slug').trim(),
        name: f.get('name').trim(),
        email: f.get('email').trim(),
        password: f.get('password'),
        acceptTerms: f.get('acceptTerms') === 'on',
      },
    });
    salvarSessao(data);
    cofre.del('aim.semAuto');
    cofre.del('aim.devLogin'); // entrou numa conta própria: não voltar sozinho para o admin do seed
    formCadastro.reset();
    enderecoEditado = false;
    await iniciar();
  });
});

// ---- Esqueci a senha ----
const formEsqueci = $('form-esqueci');
formEsqueci.addEventListener('submit', (ev) => {
  ev.preventDefault();
  enviarForm(formEsqueci, async (f) => {
    formEsqueci.querySelector('.ok').textContent = '';
    await api('/auth/forgot-password', { method: 'POST', tentarRefresh: false, body: { tenant: f.get('tenant').trim().toLowerCase(), email: f.get('email').trim() } });
    formEsqueci.querySelector('.ok').textContent = 'Se a conta e o e-mail estiverem cadastrados, o link chega em alguns minutos. Confira também o spam.';
    renderCaixaLocal(true);
  });
});

// ---- Nova senha (link do e-mail) ----
const formRedefinir = $('form-redefinir');
formRedefinir.addEventListener('submit', (ev) => {
  ev.preventDefault();
  enviarForm(formRedefinir, async (f) => {
    if (f.get('password') !== f.get('confirmar')) throw new Error('As duas senhas não são iguais.');
    if (!state.resetToken) throw new Error('Link inválido. Peça um novo em "Esqueci minha senha".');
    await api('/auth/reset-password', { method: 'POST', tentarRefresh: false, body: { token: state.resetToken, password: f.get('password') } });
    state.resetToken = null;
    formRedefinir.reset();
    limparSessao(); // a troca encerra todas as sessões, inclusive esta
    state.mensagem = 'Senha alterada. Entre com a nova senha.';
    mostrarView('login');
  });
});

/** Lê e apaga da URL os links que chegam por e-mail (?verificar=... e ?redefinir=...). */
async function tratarLinkDoEmail() {
  const params = new URLSearchParams(location.search);
  const verificar = params.get('verificar');
  const redefinir = params.get('redefinir');
  if (!verificar && !redefinir) return null;
  history.replaceState(null, '', location.pathname); // o token não fica no histórico nem vaza em links
  if (redefinir) {
    state.resetToken = redefinir;
    return 'redefinir';
  }
  try {
    await api('/auth/verify-email', { method: 'POST', tentarRefresh: false, body: { token: verificar } });
    state.mensagem = 'E-mail confirmado.';
  } catch (err) {
    state.mensagem = err.message;
  }
  return 'verificado';
}

// ---- Caixa de saída local (só existe no ambiente local com EMAIL_PROVIDER=log) ----
async function renderCaixaLocal(mostrar) {
  const caixa = $('caixa-local');
  if (!mostrar) { caixa.hidden = true; return; }
  let emails = [];
  try {
    const r = await fetch(`${API}/dev/outbox`);
    if (!r.ok) { caixa.hidden = true; return; } // produção: a rota não existe
    emails = (await r.json()).data || [];
  } catch {
    caixa.hidden = true;
    return;
  }
  caixa.hidden = false;
  caixa.innerHTML = `<p><strong>Modo local:</strong> os e-mails não saem de verdade. Os últimos aparecem aqui.</p>${
    emails.length
      ? `<ul>${emails.slice(0, 3).map((m, i) => `<li><span>${esc(m.subject)} · ${esc(m.to)} · ${esc(hora(m.sentAt))}</span>${m.link ? ` <button type="button" class="botao-link" data-email="${i}">Abrir o link</button>` : ''}</li>`).join('')}</ul>`
      : '<p class="sutil">Nenhum e-mail ainda.</p>'
  }`;
  caixa.querySelectorAll('[data-email]').forEach((b) =>
    b.addEventListener('click', () => { location.href = emails[Number(b.dataset.email)].link; })
  );
}

// ---------------------------------------------------------------------------
// Primeiros passos
// ---------------------------------------------------------------------------
async function carregarConta() {
  state.account = await api('/account');
  $('conta-nome').textContent = state.account.tenant.name;
  $('aba-inicio').hidden = state.account.onboarding.completed;
  return state.account;
}

function passosDef() {
  const simulado = Boolean(state.dev?.waMock);
  const a = state.account;
  return {
    conta: { titulo: 'Conta criada', texto: `${a.tenant.name}. Para entrar, use o endereço ${a.tenant.slug}.` },
    email: {
      titulo: 'Confirme seu e-mail',
      curto: 'o e-mail confirmado',
      texto: `Enviamos um link para ${a.user.email}. Ele vale por 48 horas.`,
      acao: { rotulo: 'Reenviar e-mail', fn: reenviarConfirmacao },
    },
    imovel: {
      titulo: 'Cadastre o primeiro imóvel',
      curto: 'um imóvel cadastrado',
      texto: 'Preço, regras (pet, moradores, garantias) e as informações extras que a assistente usa para responder.',
      acao: { rotulo: 'Cadastrar imóvel', fn: () => { mostrarView('imoveis'); abrirImovel(null); } },
    },
    whatsapp: {
      titulo: 'Conecte o WhatsApp da empresa',
      curto: 'o WhatsApp conectado',
      texto: a.whatsappSignup
        ? 'Você entra com o Facebook da empresa, escolhe o número e autoriza o Imobi. Leva poucos minutos.'
        : simulado
          ? 'Modo local: o WhatsApp está simulado, então dá para testar a conversa sem conectar.'
          : 'A conexão pelo próprio painel ainda não está disponível. Fale com o suporte para conectar o número.',
      acao: a.whatsappSignup && a.user.role === 'admin' ? { rotulo: 'Conectar WhatsApp', fn: conectarWhatsappPasso, requer: ['email'] } : null,
    },
    link: {
      titulo: 'Copie o link do anúncio',
      texto: 'Cole na descrição do anúncio. Cada clique é contado e abre o WhatsApp já com o código do imóvel.',
      acao: { rotulo: 'Copiar link', fn: copiarLinkAnuncio, requer: ['imovel', 'whatsapp'] },
    },
    teste: {
      titulo: 'Teste a conversa',
      texto: state.dev
        ? 'Use o simulador para conversar como se fosse um cliente chegando pelo anúncio.'
        : 'Abra o link do anúncio no seu celular e mande uma mensagem. A conversa aparece em Leads.',
      acao: state.dev ? { rotulo: 'Simular um lead', fn: () => { mostrarView('leads'); $('novo-simulado').click(); } } : null,
    },
  };
}

async function carregarInicio() {
  const view = $('view-inicio');
  view.querySelector('.erro').textContent = '';
  try {
    await carregarConta();
    renderInicio();
  } catch (err) {
    view.querySelector('.erro').textContent = err.message;
  }
}

function renderInicio(mensagens = {}) {
  const { steps } = state.account.onboarding;
  const def = passosDef();
  const feito = Object.fromEntries(steps.map((s) => [s.key, s.done]));
  const total = steps.filter((s) => s.done).length;
  $('inicio-progresso').textContent = total === steps.length
    ? 'Tudo pronto. A assistente já pode atender os leads dos seus anúncios.'
    : `${total} de ${steps.length} passos concluídos.`;
  $('passos').innerHTML = steps.map((s, i) => {
    const d = def[s.key];
    const pendencias = (d.acao?.requer || []).filter((k) => !feito[k]);
    const bloqueado = pendencias.length > 0;
    const botao = !s.done && d.acao
      ? `<button type="button" class="botao ${i === steps.findIndex((x) => !x.done) ? 'primario' : 'secundario'}" data-passo="${s.key}" ${bloqueado ? 'disabled' : ''}>${esc(d.acao.rotulo)}</button>`
      : '';
    const dependencia = !s.done && bloqueado ? `<p class="sutil">Depende de: ${pendencias.map((k) => esc(def[k].curto)).join(' e ')}.</p>` : '';
    return `<li class="passo${s.done ? ' feito' : ''}">
      <span class="passo-marca" aria-hidden="true">${s.done ? '✓' : i + 1}</span>
      <div class="passo-corpo">
        <h2>${esc(d.titulo)}<span class="visualmente-oculto">${s.done ? ' (concluído)' : ' (pendente)'}</span></h2>
        <p>${esc(d.texto)}</p>
        ${dependencia}
        ${mensagens[s.key] ? `<p class="ok" role="status">${esc(mensagens[s.key])}</p>` : ''}
      </div>
      ${botao}
    </li>`;
  }).join('');
  $('passos').querySelectorAll('[data-passo]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      $('view-inicio').querySelector('.erro').textContent = '';
      try {
        await def[b.dataset.passo].acao.fn();
      } catch (err) {
        $('view-inicio').querySelector('.erro').textContent = err.message;
        b.disabled = false;
      }
    })
  );
}

// ---- Conectar o WhatsApp (cadastro incorporado da Meta) ----
let sdkFacebook = null;
/** Carrega o SDK do Facebook uma vez. Só é chamado quando o servidor informa app e configuração. */
function carregarSdkFacebook({ appId, graphVersion }) {
  if (!sdkFacebook) {
    sdkFacebook = new Promise((resolve, reject) => {
      window.fbAsyncInit = () => {
        window.FB.init({ appId, autoLogAppEvents: false, xfbml: false, version: graphVersion });
        resolve();
      };
      const s = document.createElement('script');
      s.src = 'https://connect.facebook.net/pt_BR/sdk.js';
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onerror = () => { sdkFacebook = null; reject(new Error('Não foi possível abrir o login do Facebook. Confira a internet ou o bloqueador de anúncios.')); };
      document.head.appendChild(s);
    });
  }
  return sdkFacebook;
}

/**
 * Abre o cadastro da Meta. A janela da Meta avisa o número e a WABA escolhidos por mensagem
 * (WA_EMBEDDED_SIGNUP) e o login devolve um código; os três vão para o servidor concluir a conexão.
 */
async function conectarWhatsapp() {
  const cfg = state.account?.whatsappSignup;
  if (!cfg) throw new Error('Conexão pelo painel indisponível.');
  await carregarSdkFacebook(cfg);
  let sessao = null;
  const ouvir = (ev) => {
    let host = '';
    try { host = new URL(ev.origin).hostname; } catch { return; }
    if (!/(^|\.)facebook\.com$/.test(host)) return;
    try {
      const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      if (d?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (d.event === 'CANCEL') sessao = { cancelado: true };
      else if (d.data?.phone_number_id && d.data?.waba_id) sessao = { phoneNumberId: String(d.data.phone_number_id), wabaId: String(d.data.waba_id) };
    } catch { /* mensagem de outro tipo */ }
  };
  window.addEventListener('message', ouvir);
  try {
    const code = await new Promise((resolve) => {
      window.FB.login((r) => resolve(r?.authResponse?.code || null), {
        config_id: cfg.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      });
    });
    // A mensagem com o número pode chegar logo depois do login.
    for (let i = 0; i < 20 && !sessao; i += 1) await new Promise((r) => setTimeout(r, 100));
    if (!code || !sessao || sessao.cancelado) throw new Error('A conexão foi cancelada antes de terminar. Tente de novo.');
    state.account = await api('/whatsapp/connect', { method: 'POST', body: { code, wabaId: sessao.wabaId, phoneNumberId: sessao.phoneNumberId } });
  } finally {
    window.removeEventListener('message', ouvir);
  }
}

async function conectarWhatsappPasso() {
  await conectarWhatsapp();
  $('aba-inicio').hidden = state.account.onboarding.completed;
  renderInicio({ whatsapp: 'WhatsApp conectado. A assistente já pode atender por esse número.' });
  await atualizarAvisos();
}

async function reenviarConfirmacao() {
  const r = await api('/account/resend-verification', { method: 'POST' });
  await carregarConta();
  renderInicio({ email: r.alreadyVerified ? 'Seu e-mail já está confirmado.' : 'Enviamos um novo link. Confira também o spam.' });
  renderCaixaLocal(true);
}

async function copiarLinkAnuncio() {
  const imoveis = (await api('/properties')).filter((p) => p.isActive);
  if (!imoveis.length) throw new Error('Cadastre um imóvel ativo primeiro.');
  const { trackedLink } = await api(`/properties/${imoveis[0].id}/links?src=marketplace`);
  let copiado = true;
  try { await navigator.clipboard.writeText(trackedLink); } catch { copiado = false; }
  state.account = await api('/account/onboarding', { method: 'POST', body: { step: 'link' } });
  $('aba-inicio').hidden = state.account.onboarding.completed;
  renderInicio({ link: `${copiado ? 'Copiado' : 'Copie este link'}: ${trackedLink}. Cada imóvel tem o seu, na tela Imóveis.` });
}

// ---------------------------------------------------------------------------
// Hoje: resumo do dia e avisos
// ---------------------------------------------------------------------------
const minutosTexto = (m) => {
  if (m === null || m === undefined) return '';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${Math.floor(h / 24)} d`;
};
const AVISO = {
  lead_sem_retorno: (a) => ({ titulo: 'Lead esperando o corretor', texto: `Transferido há ${minutosTexto(a.details.minutos)} e ainda sem resposta de ninguém.${a.details.classificacao === 'quente' ? ' É um lead quente.' : ''}` }),
  sem_resposta: (a) => ({ titulo: 'Mensagem sem resposta', texto: `O lead escreveu há ${minutosTexto(a.details.minutos)} e a assistente ainda não respondeu. Confira a conversa.` }),
  falha_envio: () => ({ titulo: 'Resposta não chegou ao lead', texto: 'O WhatsApp recusou o envio várias vezes. Confira a conexão do número em Conta e plano.' }),
  ia_invalida: () => ({ titulo: 'A assistente não conseguiu responder', texto: 'A resposta saiu fora do formato várias vezes. Responda você pela conversa.' }),
  falha_resposta: () => ({ titulo: 'A assistente não conseguiu responder', texto: 'A resposta falhou várias vezes. Responda você pela conversa.' }),
  cadastro_incompleto: (a) => ({
    titulo: `Complete o cadastro do imóvel ${a.details.codigo || ''}`.trim(),
    texto: `${a.details.leads} leads perguntaram coisas que o cadastro não responde${(a.details.perguntas || []).length ? `: ${a.details.perguntas.map((p) => `“${p}”`).join(', ')}` : ''}. Acrescente em Informações extras.`,
  }),
};

const quentes = (n) => (n === 1 ? '1 quente' : `${n} quentes`);

function atualizarContador(n) {
  $('contador-avisos').hidden = !n;
  $('contador-avisos').textContent = n > 99 ? '99+' : String(n || '');
  $('contador-avisos').setAttribute('aria-label', `${n} avisos`);
}

async function carregarHoje() {
  const view = $('view-hoje');
  view.querySelector('.erro').textContent = '';
  try {
    const { resumo: r, avisos } = await api('/today');
    $('hoje-data').textContent = new Date(`${r.day}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
    $('hoje-resumo').innerHTML = [
      { rotulo: 'Esperando o corretor', valor: String(r.aguardando), sub: r.aguardando ? `${quentes(r.quentesAguardando)} · a mais antiga há ${minutosTexto(r.esperaMaisLongaMin)}` : 'Ninguém esperando', alerta: r.quentesAguardando > 0 },
      { rotulo: 'Visitas hoje', valor: String(r.visitasHoje), sub: 'Veja a Agenda' },
      { rotulo: 'Leads novos ontem', valor: String(r.novosOntem), sub: quentes(r.quentesOntem) },
      { rotulo: 'Avisos', valor: String(r.avisos), sub: r.avisos ? 'Abaixo' : 'Tudo em ordem', alerta: r.avisos > 0 },
    ].map(tile).join('');
    atualizarContador(avisos.length);
    $('hoje-avisos').innerHTML = avisos.length
      ? avisos.map((a) => {
          const d = (AVISO[a.kind] || (() => ({ titulo: a.kind, texto: '' })))(a);
          const quem = a.lead ? esc(a.lead.name || telefone(a.lead.phone)) : '';
          const onde = a.property ? ` · ${esc(a.property.code)}` : '';
          return `<li class="aviso-item" data-kind="${esc(a.kind)}">
            <div><strong>${esc(d.titulo)}</strong>${quem || onde ? `<span class="sutil"> ${quem}${onde}</span>` : ''}<p>${esc(d.texto)}</p></div>
            <div class="acoes">
              ${a.lead ? `<button type="button" class="botao secundario" data-abrir-lead="${esc(a.lead.id)}">Abrir conversa</button>` : ''}
              ${!a.lead && a.property ? `<button type="button" class="botao secundario" data-abrir-imovel="${esc(a.property.id)}">Abrir imóvel</button>` : ''}
              <button type="button" class="botao-texto-escuro" data-resolver="${esc(a.id)}">Resolvido</button>
            </div>
          </li>`;
        }).join('')
      : '<li class="sutil">Nenhum aviso. A assistente está dando conta.</li>';
    $('hoje-avisos').querySelectorAll('[data-abrir-lead]').forEach((b) => b.addEventListener('click', () => { state.leadId = b.dataset.abrirLead; mostrarView('leads'); selecionarLead(b.dataset.abrirLead); }));
    $('hoje-avisos').querySelectorAll('[data-abrir-imovel]').forEach((b) => b.addEventListener('click', () => { mostrarView('imoveis'); abrirImovel(b.dataset.abrirImovel); }));
    $('hoje-avisos').querySelectorAll('[data-resolver]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api(`/alerts/${b.dataset.resolver}`, { method: 'PATCH', body: {} }); await carregarHoje(); }
      catch (err) { view.querySelector('.erro').textContent = err.message; b.disabled = false; }
    }));
  } catch (err) {
    view.querySelector('.erro').textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// Agenda de visitas
// ---------------------------------------------------------------------------
const SITUACAO_VISITA = { agendada: 'Agendada', realizada: 'Realizada', nao_compareceu: 'Não compareceu', cancelada: 'Cancelada' };
let horariosLivres = null; // cache curto dos horários livres (remarcar)

async function buscarHorariosLivres() {
  horariosLivres = (await api('/visits/slots')).slots;
  return horariosLivres;
}
const opcoesHorario = (slots) => slots.map((s) => `<option value="${esc(s.startsAt)}">${esc(s.label)}</option>`).join('');

async function carregarAgenda() {
  const view = $('view-agenda');
  view.querySelector('.erro').textContent = '';
  try {
    const { visits, timezone } = await api('/visits');
    const porDia = new Map();
    for (const v of visits) {
      const d = new Date(v.startsAt).toLocaleDateString('pt-BR', { timeZone: timezone, weekday: 'long', day: '2-digit', month: 'long' });
      const dia = d.charAt(0).toUpperCase() + d.slice(1);
      if (!porDia.has(dia)) porDia.set(dia, []);
      porDia.get(dia).push(v);
    }
    const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
    $('agenda-dias').innerHTML = visits.length
      ? [...porDia.entries()].map(([dia, lista]) => `
        <section class="bloco agenda-dia">
          <h2>${esc(dia)}</h2>
          <ul class="visitas">${lista.map((v) => `
            <li class="visita" data-status="${esc(v.status)}">
              <span class="visita-hora">${esc(hora(v.startsAt))}</span>
              <div class="visita-corpo">
                <strong>${esc(v.lead.name || (v.lead.phone ? telefone(v.lead.phone) : 'Lead excluído'))}</strong>
                <span class="sutil">${esc(v.property.code)} · ${esc(v.property.title)} · ${esc(SITUACAO_VISITA[v.status])}${v.createdBy === 'assistente' ? ' · marcada pela assistente' : ''}${v.reminderSent ? ' · lembrete enviado' : ''}</span>
              </div>
              ${v.status === 'agendada' ? `<div class="acoes">
                <button type="button" class="botao secundario" data-visita="${esc(v.id)}" data-acao="realizada">Realizada</button>
                <button type="button" class="botao secundario" data-visita="${esc(v.id)}" data-acao="nao_compareceu">Não veio</button>
                <button type="button" class="botao secundario" data-visita="${esc(v.id)}" data-acao="remarcar">Remarcar</button>
                <button type="button" class="botao secundario perigo" data-visita="${esc(v.id)}" data-acao="cancelada">Cancelar</button>
              </div>` : ''}
            </li>`).join('')}</ul>
        </section>`).join('')
      : '<p class="sutil">Nenhuma visita marcada. Quando o lead escolher um horário com a assistente, ou você agendar pela ficha do lead, ela aparece aqui.</p>';
    $('agenda-dias').querySelectorAll('[data-visita]').forEach((b) => b.addEventListener('click', () => acaoVisita(b)));
  } catch (err) {
    view.querySelector('.erro').textContent = err.message;
  }
}

async function acaoVisita(b) {
  const erro = $('view-agenda').querySelector('.erro');
  erro.textContent = '';
  const id = b.dataset.visita;
  try {
    if (b.dataset.acao === 'remarcar') {
      const li = b.closest('.visita');
      if (li.querySelector('.remarcar')) return;
      const slots = await buscarHorariosLivres();
      const form = document.createElement('div');
      form.className = 'acoes remarcar';
      form.innerHTML = `<select aria-label="Novo horário">${opcoesHorario(slots)}</select><button type="button" class="botao primario">Confirmar</button>`;
      li.appendChild(form);
      form.querySelector('button').addEventListener('click', async () => {
        try { await api(`/visits/${id}`, { method: 'PATCH', body: { startsAt: form.querySelector('select').value } }); await carregarAgenda(); }
        catch (err) { erro.textContent = err.message; }
      });
      return;
    }
    if (b.dataset.acao === 'cancelada' && !confirm('Cancelar esta visita? O lead volta para o corretor combinar outro horário.')) return;
    b.disabled = true;
    await api(`/visits/${id}`, { method: 'PATCH', body: { status: b.dataset.acao } });
    await carregarAgenda();
  } catch (err) {
    erro.textContent = err.message;
    b.disabled = false;
  }
}

// Ficha do lead: agendar visita pelo painel.
async function renderVisitaLead(l) {
  const bloco = $('lead-visita');
  const podeAgendar = !l.anonymized && l.status !== 'opt_out' && l.property;
  bloco.hidden = !podeAgendar && !l.visitPreference;
  $('lead-visita-erro').textContent = '';
  $('lead-visita-texto').textContent = l.status === 'visita_agendada' && l.visitPreference
    ? `Marcada: ${l.visitPreference}. Para mudar, use a Agenda.`
    : l.visitPreference ? `Preferência do lead: ${l.visitPreference}.` : 'Ainda sem visita.';
  $('lead-visita-acoes').hidden = !podeAgendar || l.status === 'visita_agendada';
  if (!$('lead-visita-acoes').hidden && $('lead-visita-horario').dataset.lead !== l.id) {
    $('lead-visita-horario').dataset.lead = l.id;
    try {
      const slots = horariosLivres || (await buscarHorariosLivres());
      $('lead-visita-horario').innerHTML = slots.length ? opcoesHorario(slots) : '<option value="">Sem horários livres na grade</option>';
    } catch { /* sem horários */ }
  }
}
$('lead-visita-agendar').addEventListener('click', async (ev) => {
  if (!state.lead || !$('lead-visita-horario').value) return;
  ev.target.disabled = true;
  $('lead-visita-erro').textContent = '';
  try {
    await api('/visits', { method: 'POST', body: { leadId: state.lead.id, startsAt: $('lead-visita-horario').value } });
    horariosLivres = null;
    $('lead-visita-horario').dataset.lead = '';
    await carregarLead();
    await carregarLeads();
  } catch (err) {
    $('lead-visita-erro').textContent = err.message;
  } finally {
    ev.target.disabled = false;
  }
});

/** '9h-12h', '9-12', '09:00 - 12:30' -> '09:00-12:30'. Texto não reconhecido segue igual (o servidor recusa explicando). */
function normalizarFaixa(x) {
  const t = String(x).trim().replace(/\s+/g, '').toLowerCase();
  if (!t) return '';
  const m = /^(\d{1,2})(?:[:h](\d{2}))?h?(?:-|a|até)(\d{1,2})(?:[:h](\d{2}))?h?$/.exec(t);
  if (!m) return t;
  const hh = (h, mi) => `${String(h).padStart(2, '0')}:${mi || '00'}`;
  return `${hh(m[1], m[2])}-${hh(m[3], m[4])}`;
}

// Conta: rotina e grade de horários (admin).
const NOMES_DIA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
function renderRotina() {
  const t = state.account?.tenant;
  const admin = state.user?.role === 'admin';
  $('bloco-rotina').hidden = !admin || !t;
  $('bloco-horarios').hidden = !admin || !t;
  if (!admin || !t) return;
  const fr = $('form-rotina');
  fr.timezone.value = t.timezone || 'America/Sao_Paulo';
  fr.handoffSlaMinutes.value = String(t.handoffSlaMinutes || 120);
  fr.digestEnabled.checked = t.digestEnabled !== false;
  const g = t.visitSchedule || { slotMinutes: 60, days: {} };
  $('form-horarios').slotMinutes.value = String(g.slotMinutes || 60);
  const ordem = [1, 2, 3, 4, 5, 6, 0];
  $('horarios-dias').innerHTML = ordem.map((d) => `
    <label class="campo dia"><span>${NOMES_DIA[d]}</span>
      <input name="dia-${d}" type="text" inputmode="numeric" placeholder="sem visitas" value="${esc((g.days?.[d] || g.days?.[String(d)] || []).join(', '))}">
    </label>`).join('');
}
$('form-rotina').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  form.querySelector('.ok').textContent = '';
  enviarForm(form, async (f) => {
    state.account = await api('/account/routine', { method: 'PATCH', body: { timezone: f.get('timezone'), handoffSlaMinutes: Number(f.get('handoffSlaMinutes')), digestEnabled: form.digestEnabled.checked } });
    form.querySelector('.ok').textContent = 'Rotina salva.';
  });
});
$('form-horarios').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  form.querySelector('.ok').textContent = '';
  enviarForm(form, async (f) => {
    const days = {};
    for (let d = 0; d <= 6; d += 1) {
      const faixas = String(f.get(`dia-${d}`) || '').split(/[,;]/).map(normalizarFaixa).filter(Boolean);
      if (faixas.length) days[d] = faixas;
    }
    state.account = await api('/account/visit-schedule', { method: 'PATCH', body: { slotMinutes: Number(f.get('slotMinutes')), days } });
    horariosLivres = null;
    renderRotina();
    form.querySelector('.ok').textContent = 'Horários salvos.';
  });
});

// ---------------------------------------------------------------------------
// Plano e uso
// ---------------------------------------------------------------------------
const dataCurta = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
const MOTIVO_PLANO = {
  teste_expirado: 'O teste grátis terminou.',
  pagamento_atrasado: 'O pagamento está atrasado.',
  assinatura_cancelada: 'A assinatura foi cancelada.',
  plano_desconhecido: 'Há um problema com o plano da conta.',
  situacao_desconhecida: 'Há um problema com a assinatura da conta.',
};
const diasTexto = (n) => (n === 1 ? '1 dia' : `${n} dias`);

/** Uma frase sobre a situação do plano, a mesma no aviso do topo e na tela Plano e uso. */
function situacaoPlano(b) {
  const s = b.subscription;
  if (!b.billing.enabled) return { texto: 'Período de piloto: sem limite de uso e sem cobrança. Os números abaixo ajudam a medir o custo real do atendimento.', alerta: false };
  if (!s.active) return { texto: `${MOTIVO_PLANO[s.reason] || 'A assinatura não está ativa.'} Leads novos vão direto para o corretor, sem a assistente. Escolha um plano para voltar a atender.`, alerta: true };
  if (s.status === 'teste') return { texto: `Teste grátis: ${s.daysLeft === 0 ? 'termina hoje' : `faltam ${diasTexto(s.daysLeft)}`} (até ${dataCurta(s.trialEndsAt)}).`, alerta: s.warning === 'teste_acabando' };
  if (s.status === 'inadimplente') return { texto: `Pagamento atrasado. A assistente continua atendendo até ${dataCurta(s.graceUntil)}. Depois disso, leads novos vão direto para o corretor.`, alerta: true };
  if (s.status === 'cancelada') return { texto: `Assinatura cancelada. O plano ${s.planName} vale até ${dataCurta(s.currentPeriodEnd)}.`, alerta: true };
  if (s.plan === 'interno') return { texto: 'Conta interna, sem limite de uso.', alerta: false };
  return { texto: `Plano ${s.planName} ativo${s.currentPeriodEnd ? `, renovação em ${dataCurta(s.currentPeriodEnd)}` : ''}.`, alerta: false };
}

/** Avisos do plano para o topo do painel: situação ruim ou uso a partir de 80%. */
function avisosPlano(b) {
  const avisos = [];
  if (!b.billing.enabled) return avisos; // modo piloto: sem plano, sem limite
  const sit = situacaoPlano(b);
  if (sit.alerta) avisos.push(esc(sit.texto));
  const pc = b.percent.conversations;
  if (b.subscription.active && pc !== null && pc >= 80) {
    avisos.push(pc >= 100
      ? `O limite de ${b.limits.conversations} conversas do mês acabou: leads novos vão direto para o corretor.`
      : `Você já usou ${pc}% das ${b.limits.conversations} conversas do mês.`);
  }
  return avisos;
}

let planoEscolhido = null;

async function carregarPlano() {
  const view = $('view-plano');
  view.querySelector('.erro').textContent = '';
  try {
    state.billing = await api('/billing');
    renderPlano();
  } catch (err) {
    view.querySelector('.erro').textContent = err.message;
  }
  carregarWhatsapp();
}

const QUALIDADE = { GREEN: 'boa', YELLOW: 'média', RED: 'baixa' };
async function carregarWhatsapp() {
  $('whatsapp-erro').textContent = '';
  const admin = state.user?.role === 'admin';
  try {
    const w = await api('/whatsapp');
    if (w.connected) {
      const partes = [`Conectado: ${telefone(w.displayPhone)}`];
      if (w.verifiedName) partes.push(`nome ${w.verifiedName}`);
      if (w.quality) partes.push(`qualidade ${QUALIDADE[w.quality] || w.quality}`);
      $('whatsapp-situacao').textContent = `${partes.join(', ')}.`;
    } else {
      $('whatsapp-situacao').textContent = w.signupAvailable
        ? 'Nenhum número conectado. Conecte o WhatsApp da empresa para a assistente atender.'
        : 'Nenhum número conectado. A conexão pelo painel ainda não está disponível: fale com o suporte.';
    }
    $('whatsapp-conectar').hidden = !(admin && !w.connected && w.signupAvailable);
    $('whatsapp-desconectar').hidden = !(admin && w.connected && w.ownToken);
  } catch (err) {
    $('whatsapp-erro').textContent = err.message;
  }
}
$('whatsapp-conectar').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  $('whatsapp-erro').textContent = '';
  try {
    await conectarWhatsapp();
    await carregarWhatsapp();
    await atualizarAvisos();
  } catch (err) {
    $('whatsapp-erro').textContent = err.message;
  } finally {
    ev.target.disabled = false;
  }
});
$('whatsapp-desconectar').addEventListener('click', async (ev) => {
  if (!confirm('Desconectar o WhatsApp? A assistente para de atender por esse número até conectar de novo.')) return;
  ev.target.disabled = true;
  $('whatsapp-erro').textContent = '';
  try {
    state.account = await api('/whatsapp/disconnect', { method: 'POST' });
    await carregarWhatsapp();
    await atualizarAvisos();
  } catch (err) {
    $('whatsapp-erro').textContent = err.message;
  } finally {
    ev.target.disabled = false;
  }
});

function renderPlano() {
  const b = state.billing;
  const sit = situacaoPlano(b);
  $('plano-situacao').textContent = sit.texto;
  $('plano-situacao').className = sit.alerta ? 'alerta-texto' : 'sutil';

  const de = (usado, limite) => (limite === null ? String(usado) : `${usado} de ${limite}`);
  const sub = (pc, semLimite) => (pc === null ? semLimite : `${pc}% do plano`);
  $('plano-uso').innerHTML = [
    { rotulo: 'Conversas no mês', valor: de(b.usage.conversations, b.limits.conversations), sub: sub(b.percent.conversations, 'Sem limite'), alerta: b.percent.conversations >= 80 },
    { rotulo: 'Imóveis ativos', valor: de(b.usage.activeProperties, b.limits.properties), sub: sub(b.percent.properties, 'Sem limite'), alerta: b.percent.properties >= 100 },
    { rotulo: 'Respostas da assistente', valor: String(b.usage.aiCalls), sub: 'Rodadas de conversa no mês' },
    { rotulo: 'Avisos pagos enviados', valor: String(b.usage.templatesSent), sub: 'Templates do WhatsApp no mês' },
  ].map(tile).join('');

  const admin = state.user?.role === 'admin';
  $('bloco-planos').hidden = !b.billing.enabled; // modo piloto: sem planos à venda
  // Plano atual: pago e em dia, ou atrasado (a cobrança em aberto é paga pelo link que o sistema de cobrança enviou).
  const atual = ['ativa', 'inadimplente'].includes(b.subscription.status) ? b.subscription.plan : null;
  const cancelado = b.subscription.status === 'cancelada' ? b.subscription.plan : null;
  $('planos').innerHTML = b.plans.map((p) => `
    <article class="plano-cartao${atual === p.key ? ' atual' : ''}">
      <h3>${esc(p.name)}</h3>
      <p class="preco">${esc(reais(p.priceCents))}<span>/mês</span></p>
      <p class="sutil">${esc(p.description)}</p>
      <ul>
        <li>${p.limits.conversations === null ? 'Conversas sem limite' : `${p.limits.conversations} conversas por mês`}</li>
        <li>${p.limits.properties === null ? 'Imóveis sem limite' : `Até ${p.limits.properties} imóveis ativos`}</li>
        <li>${p.limits.users === null ? 'Usuários sem limite' : `${p.limits.users} ${p.limits.users === 1 ? 'usuário' : 'usuários'}`}</li>
      </ul>
      ${atual === p.key
        ? `<p class="selo">Seu plano</p>${b.subscription.status === 'inadimplente' ? '<p class="sutil">A cobrança em aberto está no e-mail enviado pelo sistema de cobrança.</p>' : ''}`
        : admin
          ? `<button type="button" class="botao primario" data-plano="${esc(p.key)}">${cancelado === p.key ? 'Reativar' : 'Escolher'} ${esc(p.name)}</button>`
          : '<p class="sutil">Só o administrador da conta pode mudar o plano.</p>'}
    </article>`).join('');
  $('planos').querySelectorAll('[data-plano]').forEach((btn) => btn.addEventListener('click', () => abrirCheckout(btn.dataset.plano)));
  renderRotina();
  // Privacidade e exclusão da conta: só o admin vê.
  $('bloco-privacidade').hidden = !admin;
  $('bloco-excluir-conta').hidden = !admin;
  if (admin && state.account) {
    $('form-retencao').retentionMonths.value = String(state.account.tenant.retentionMonths || 12);
    $('excluir-slug').textContent = state.account.tenant.slug;
  }
  // Modo local: simular o aviso do provedor depois de escolher um plano (ou com um plano pago já ativo).
  const s = b.subscription;
  $('plano-simulacao').hidden = !(b.billing.simulated && (s.pendingPlan || !['teste', 'interno'].includes(s.plan)));
}

function abrirCheckout(chave) {
  const p = state.billing.plans.find((x) => x.key === chave);
  planoEscolhido = chave;
  $('checkout-plano').textContent = `Plano ${p.name}: ${reais(p.priceCents)} por mês.`;
  $('form-checkout').hidden = false;
  $('form-checkout').querySelector('.erro').textContent = '';
  $('form-checkout').document.focus();
}
$('checkout-cancelar').addEventListener('click', () => { $('form-checkout').hidden = true; planoEscolhido = null; });
$('form-checkout').addEventListener('submit', (ev) => {
  ev.preventDefault();
  enviarForm($('form-checkout'), async (f) => {
    const r = await api('/billing/checkout', { method: 'POST', body: { plan: planoEscolhido, document: f.get('document') } });
    if (r.checkoutUrl) { location.href = r.checkoutUrl; return; } // página de pagamento do provedor
    $('form-checkout').hidden = true;
    $('form-checkout').reset();
    await carregarPlano();
    if (!r.simulated) throw new Error('A cobrança foi criada, mas o link de pagamento ainda não saiu. Tente de novo em instantes.');
  });
});
document.querySelectorAll('[data-simular]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const erro = $('view-plano').querySelector('.erro');
    erro.textContent = '';
    btn.disabled = true;
    try {
      await api('/dev/billing/simulate', { method: 'POST', body: { kind: btn.dataset.simular } });
      await carregarPlano();
      await atualizarAvisos();
    } catch (err) {
      erro.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  })
);

$('form-retencao').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  form.querySelector('.ok').textContent = '';
  enviarForm(form, async (f) => {
    state.account = await api('/account/privacy', { method: 'PATCH', body: { retentionMonths: Number(f.get('retentionMonths')) } });
    form.querySelector('.ok').textContent = 'Prazo salvo.';
  });
});
$('form-excluir-conta').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  enviarForm(form, async (f) => {
    if (f.get('slug').trim().toLowerCase() !== state.account.tenant.slug) throw new Error('O endereço digitado não é o desta conta.');
    if (!confirm('Última confirmação: excluir a conta e todos os dados para sempre?')) return;
    await api('/account', { method: 'DELETE', body: { slug: f.get('slug').trim().toLowerCase(), password: f.get('password') } });
    form.reset();
    limparSessao();
    cofre.set('aim.semAuto', '1');
    state.account = null;
    state.mensagem = 'Conta excluída. Todos os dados foram apagados.';
    mostrarView('login');
  });
});

/** Monta o aviso do topo: mensagem pendente, e-mail, plano e modo local. */
async function atualizarAvisos() {
  const avisos = [];
  if (state.mensagem) { avisos.push(esc(state.mensagem)); state.mensagem = ''; }
  if (state.account && !state.account.user.emailVerified) avisos.push(`Confirme seu e-mail: enviamos um link para ${esc(state.account.user.email)}.`);
  try {
    state.billing = await api('/billing');
    avisos.push(...avisosPlano(state.billing));
  } catch { /* sem aviso de plano se a consulta falhar */ }
  try { atualizarContador((await api('/today')).avisos.length); } catch { /* contador fica como está */ }
  if (state.dev) {
    if (!state.dev.aiConfigured) avisos.push('A assistente não vai responder: preencha <code>ANTHROPIC_API_KEY</code> no .env e reinicie a API.');
    if (state.dev.waMock) avisos.push('Modo simulação: nenhuma mensagem sai para o WhatsApp de verdade.');
    else if (state.dev.tenant && !state.dev.tenant.waConfigured) avisos.push('A conta ainda não tem WhatsApp conectado.');
  }
  $('aviso').innerHTML = avisos.join(' ');
  $('aviso').hidden = avisos.length === 0;
}

async function iniciar() {
  $('usuario-nome').textContent = state.user?.name || '';
  try {
    state.dev = await api('/dev/status');
  } catch {
    state.dev = null; // produção: sem simulador
  }
  await carregarConta();
  await atualizarAvisos();
  $('novo-simulado').hidden = !state.dev;
  $('enviar-lead').hidden = !state.dev;
  $('conversa-vazia-dica').textContent = state.dev ? 'Ou use "Simular um lead novo" para conversar como se fosse um cliente chegando pelo anúncio.' : '';
  mostrarView(state.account.onboarding.completed ? 'hoje' : 'inicio');
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
  const admin = state.user?.role === 'admin';
  $('lead-privacidade').hidden = !admin || l.anonymized;
  $('lead-anonimizado').hidden = !l.anonymized;
  if (l.anonymized) sel.disabled = true;
  renderVisitaLead(l);
  $('lead-handoff').textContent = l.handoffAt ? `Transferido em ${dataHora(l.handoffAt)}${l.handoffReason ? `: ${l.handoffReason}` : ''}` : (l.status === 'opt_out' ? 'O lead pediu para não receber mais mensagens.' : '');
}
$('lead-status').addEventListener('change', async (ev) => {
  if (!state.lead) return;
  try { await api(`/leads/${state.lead.id}`, { method: 'PATCH', body: { status: ev.target.value } }); await carregarLead(); await carregarLeads(); }
  catch (err) { $('mensagem-erro').textContent = err.message; }
});

// LGPD: cópia dos dados e exclusão a pedido do titular.
$('lead-exportar').addEventListener('click', async () => {
  if (!state.lead) return;
  $('lead-privacidade-erro').textContent = '';
  try {
    const dados = await api(`/leads/${state.lead.id}/privacy-export`);
    const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dados-do-lead-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    $('lead-privacidade-erro').textContent = err.message;
  }
});
$('lead-excluir').addEventListener('click', async () => {
  if (!state.lead) return;
  const nome = state.lead.name || telefone(state.lead.phone);
  if (!confirm(`Excluir os dados de ${nome}? A conversa e os dados pessoais somem e não dá para desfazer.`)) return;
  $('lead-privacidade-erro').textContent = '';
  try {
    await api(`/leads/${state.lead.id}`, { method: 'DELETE' });
    await carregarLead();
    await carregarLeads();
  } catch (err) {
    $('lead-privacidade-erro').textContent = err.message;
  }
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

  // Link do e-mail: "redefinir" abre a tela de nova senha; "verificar" confirma e segue o fluxo normal.
  if ((await tratarLinkDoEmail()) === 'redefinir') {
    mostrarView('redefinir');
    return;
  }
  // Modo piloto: cadastro fechado esconde "Criar uma conta" e ignora o link direto.
  try {
    const cfg = await (await fetch(`${API}/public-config`)).json();
    state.publicConfig = cfg.data || {};
  } catch {
    state.publicConfig = {};
  }
  const cadastroAberto = state.publicConfig.signupEnabled !== false;
  $('link-cadastro').hidden = !cadastroAberto;
  // Link direto para criar conta ou recuperar a senha (ex.: botão "Teste grátis" do site).
  const telaPedida = { '#cadastro': cadastroAberto ? 'cadastro' : 'login', '#esqueci': 'esqueci' }[location.hash];
  if (telaPedida && !state.accessToken) {
    mostrarView(telaPedida);
    return;
  }

  if (state.accessToken) {
    try { await iniciar(); return; } catch { limparSessao(); }
  }
  // Sem sessão: no ambiente local entra sozinho, a menos que a pessoa tenha clicado em "Sair".
  if (cofre.get('aim.semAuto') !== '1' && (await entrarAutomatico())) return;
  mostrarView('login');
  $('login-dev').hidden = cofre.get('aim.devLogin') !== '1';
})();
