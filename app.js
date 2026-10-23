// ==========================================
// SECURITY UTILITIES & DATA PERSISTENCE (SUPABASE & REALTIME)
// ==========================================

/**
 * Sanitiza strings fornecidas pelo usuário para prevenir ataques XSS (Cross-Site Scripting).
 * Converte caracteres especiais (&, <, >, ", ', `) em entidades HTML seguras.
 * @param {string|number|null|undefined} str
 * @returns {string}
 */
function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/`/g, '&#x60;');
}

// Carregamento dinâmico e seguro de credenciais
// Ordem de precedência: window.__CONFIG__ (config.js) -> window.__ENV__ -> localStorage -> credenciais do projeto
const SUPABASE_URL = (typeof window !== 'undefined' && (window.__CONFIG__?.SUPABASE_URL || window.__ENV__?.SUPABASE_URL))
  || (typeof localStorage !== 'undefined' ? (localStorage.getItem('PG_SUPABASE_URL') || '') : '')
  || 'https://lakilyuxnvxexkmophkl.supabase.co';

const SUPABASE_ANON_KEY = (typeof window !== 'undefined' && (window.__CONFIG__?.SUPABASE_ANON_KEY || window.__ENV__?.SUPABASE_ANON_KEY))
  || (typeof localStorage !== 'undefined' ? (localStorage.getItem('PG_SUPABASE_ANON_KEY') || '') : '')
  || 'sb_publishable_GKkPy4bq09hBeEpcsMuTfA_SX9EYOhm';

let supabaseClient = null;
if (window.supabase && typeof window.supabase.createClient === 'function' && SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (err) {
    console.error('Falha ao inicializar o cliente Supabase:', err);
  }
}

let trackerData = { days: [], dailyNotes: [] };
let globalBalance = 0;
let balanceHistory = [];

// Each heavy list only mounts ten calendar days at a time. This keeps the
// dashboard responsive even when the tracker has a long history.
const DAYS_PER_PAGE = 10;
let dashboardPage = 1;
let historyPage = 1;
let summaryPage = 1;

function ensureTrackerDataShape() {
  if (!trackerData || typeof trackerData !== 'object') trackerData = {};
  if (!Array.isArray(trackerData.days)) trackerData.days = [];
  if (!Array.isArray(trackerData.dailyNotes)) trackerData.dailyNotes = [];
  if (!trackerData.goal || typeof trackerData.goal !== 'object') {
    trackerData.goal = { amount: 0, startDate: '' };
  }
  trackerData.goal.amount = Math.max(0, parseFloat(trackerData.goal.amount) || 0);
  trackerData.goal.startDate = trackerData.goal.startDate || '';
}

// Status indicator updater
function showSyncIndicator(state, message) {
  const statusContainer = document.getElementById('sync-status');
  const statusText = document.getElementById('sync-status-text');
  if (!statusContainer || !statusText) return;

  statusContainer.classList.remove('hidden');

  if (state === 'loading' || state === 'saving') {
    statusContainer.className = 'hidden sm:flex items-center gap-1.5 px-2 py-0.5 bg-amber-950/40 border border-amber-500/30 rounded-lg text-[10px] font-semibold text-amber-400';
    statusText.textContent = message || (state === 'loading' ? 'Carregando nuvem...' : 'Salvando...');
  } else if (state === 'error') {
    statusContainer.className = 'hidden sm:flex items-center gap-1.5 px-2 py-0.5 bg-rose-950/40 border border-rose-500/30 rounded-lg text-[10px] font-semibold text-rose-400';
    statusText.textContent = message || 'Erro de sincronização';
  } else {
    statusContainer.className = 'hidden sm:flex items-center gap-1.5 px-2 py-0.5 bg-emerald-950/40 border border-emerald-500/30 rounded-lg text-[10px] font-semibold text-emerald-400';
    statusText.textContent = message || 'Supabase Conectado';
  }
}

// Local cache helpers as secondary backup
function loadLocalFallback() {
  try {
    const stored = localStorage.getItem('sports_betting_tracker_data');
    if (stored) trackerData = JSON.parse(stored);
    ensureTrackerDataShape();



    globalBalance = parseFloat(localStorage.getItem('planilhagulosa_global_balance')) || 0;

    const histStored = localStorage.getItem('planilhagulosa_balance_history');
    if (histStored) balanceHistory = JSON.parse(histStored);
    if (!Array.isArray(balanceHistory)) balanceHistory = [];
  } catch (e) {
    trackerData = { days: [], dailyNotes: [], goal: { amount: 0, startDate: '' } };
    globalBalance = 0;
    balanceHistory = [];
  }
}

function saveLocalFallback() {
  try {
    localStorage.setItem('sports_betting_tracker_data', JSON.stringify(trackerData));
    localStorage.setItem('planilhagulosa_global_balance', globalBalance.toString());
    localStorage.setItem('planilhagulosa_balance_history', JSON.stringify(balanceHistory));
  } catch (e) {}
}

// Load data directly from Supabase DB table app_state using user.id
async function loadData() {
  showSyncIndicator('loading', 'Conectando Supabase...');

  if (!supabaseClient) {
    console.warn('SDK do Supabase não encontrado. Usando cache local.');
    loadLocalFallback();
    showSyncIndicator('error', 'Supabase indisponível');
    return;
  }

  try {
    const { data: userData } = await supabaseClient.auth.getUser();
    const user = userData?.user;

    if (!user) {
      console.warn('Nenhum usuário logado no Supabase. Usando cache local.');
      loadLocalFallback();
      showSyncIndicator('error', 'Não autenticado');
      return;
    }

    // Busca o registro na tabela app_state associado ao user_id / UUID do usuário
    let { data, error } = await supabaseClient
      .from('app_state')
      .select('*')
      .eq('user_id', user.id);

    if (error || !data || data.length === 0) {
      const fallbackById = await supabaseClient
        .from('app_state')
        .select('*')
        .eq('id', user.id);

      if (!fallbackById.error && fallbackById.data && fallbackById.data.length > 0) {
        data = fallbackById.data;
        error = null;
      }
    }

    if (error) {
      console.error('Erro ao ler tabela app_state no Supabase:', error);
      loadLocalFallback();
      showSyncIndicator('error', 'Erro na leitura da nuvem');
      return;
    }

    if (data && data.length > 0) {
      const row = data[0];

      if (row.tracker_data) {
        trackerData = typeof row.tracker_data === 'string' ? JSON.parse(row.tracker_data) : row.tracker_data;
      } else {
        trackerData = { days: [], dailyNotes: [], goal: { amount: 0, startDate: '' } };
      }
      ensureTrackerDataShape();

      if (row.global_balance !== undefined && row.global_balance !== null) {
        globalBalance = parseFloat(row.global_balance) || 0;
      }

      if (row.balance_history) {
        balanceHistory = typeof row.balance_history === 'string' ? JSON.parse(row.balance_history) : row.balance_history;
      }
      if (!Array.isArray(balanceHistory)) balanceHistory = [];

      saveLocalFallback();
      showSyncIndicator('synced', 'Supabase Conectado');
    } else {
      console.log(`Nenhum registro encontrado em app_state para user_id=${user.id}. Criando novo estado...`);
      trackerData = { days: [], dailyNotes: [], goal: { amount: 0, startDate: '' } };
      globalBalance = 0;
      balanceHistory = [];
      saveLocalFallback();
      await saveDataImmediate();
    }
  } catch (err) {
    console.error('Falha na comunicação com Supabase:', err);
    loadLocalFallback();
    showSyncIndicator('error', 'Modo Offline');
  }
}

// Immediate save to Supabase using user.id as record identifier
async function saveDataImmediate() {
  saveLocalFallback();

  if (!supabaseClient) return;

  showSyncIndicator('saving', 'Salvando...');

  try {
    const { data: userData } = await supabaseClient.auth.getUser();
    const user = userData?.user;

    if (!user) {
      console.warn('Não foi possível salvar: Usuário não autenticado.');
      showSyncIndicator('error', 'Não autenticado');
      return;
    }

    // Vincula o identificador do registro (id e user_id) diretamente ao UUID do usuário logado
    const record = {
      id: user.id,
      user_id: user.id,
      tracker_data: trackerData,
      global_balance: globalBalance,
      balance_history: balanceHistory,
      updated_at: new Date().toISOString()
    };

    let { error } = await supabaseClient
      .from('app_state')
      .upsert(record);

    if (error) {
      const retryWithConflict = await supabaseClient
        .from('app_state')
        .upsert(record, { onConflict: 'user_id' });
      error = retryWithConflict.error;
    }

    if (error) {
      console.error('Erro ao salvar no Supabase:', error);
      showSyncIndicator('error', 'Erro ao salvar na nuvem');
      return;
    }

    showSyncIndicator('synced', 'Salvo no Supabase');
  } catch (err) {
    console.error('Erro ao salvar no Supabase:', err);
    showSyncIndicator('error', 'Erro na nuvem');
  }
}

let saveTimeout = null;
function saveData() {
  if (saveTimeout) clearTimeout(saveTimeout);
  showSyncIndicator('saving', 'Salvando...');
  saveTimeout = setTimeout(() => {
    saveDataImmediate();
  }, 400);
}

function debouncedSaveData() {
  saveData();
}

// Subscribe to Supabase Realtime changes for cross-device sync
function initRealtimeSync() {
  if (!supabaseClient) return;

  try {
    supabaseClient
      .channel('app_state_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_state' },
        (payload) => {
          handleRealtimeUpdate(payload);
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('Sincronização em tempo real ativada com sucesso!');
        }
      });
  } catch (e) {
    console.error('Erro ao inicializar Realtime:', e);
  }
}

async function handleRealtimeUpdate(payload) {
  const newRow = payload.new;
  if (!newRow) return;

  // Filtrar atualizações em tempo real pelo user.id do usuário atual
  let currentUser = null;
  if (supabaseClient) {
    const { data: userData } = await supabaseClient.auth.getUser();
    currentUser = userData?.user;
  }
  if (!currentUser) return;

  const isUserRow = (newRow.user_id && newRow.user_id === currentUser.id) ||
                    (newRow.id && String(newRow.id) === String(currentUser.id));
  if (!isUserRow) return;

  let updated = false;

  let remoteTracker = null;
  if (newRow.tracker_data) {
    remoteTracker = typeof newRow.tracker_data === 'string' ? JSON.parse(newRow.tracker_data) : newRow.tracker_data;
  }

  if (remoteTracker && JSON.stringify(remoteTracker) !== JSON.stringify(trackerData)) {
    trackerData = remoteTracker;
    ensureTrackerDataShape();
    updated = true;
  }

  let remoteBalance = null;
  if (newRow.global_balance !== undefined && newRow.global_balance !== null) {
    remoteBalance = parseFloat(newRow.global_balance) || 0;
  }

  if (remoteBalance !== null && remoteBalance !== globalBalance) {
    globalBalance = remoteBalance;
    updated = true;
  }

  let remoteHistory = null;
  if (newRow.balance_history) {
    remoteHistory = typeof newRow.balance_history === 'string' ? JSON.parse(newRow.balance_history) : newRow.balance_history;
  }

  if (remoteHistory && JSON.stringify(remoteHistory) !== JSON.stringify(balanceHistory)) {
    balanceHistory = remoteHistory;
    updated = true;
  }

  if (updated) {
    saveLocalFallback();
    renderAllDays(document.getElementById('input-search-days')?.value || '');
    updateGlobalCapital();
    renderHistory();
    renderDailyNotes(document.getElementById('input-search-notes')?.value || '');
    showSyncIndicator('synced', 'Atualizado em tempo real');
  }
}

window.addEventListener('beforeunload', () => {
  if (saveTimeout) {
    saveDataImmediate();
  }
});

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

// Format date YYYY-MM-DD -> DD/MM (Weekday)
function formatDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const weekday = weekdays[date.getDay()];
    return `${parts[2]}/${parts[1]} (${weekday})`;
  }
  return dateStr;
}

// Format numbers as Brazilian Real currency
function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value);
}

function clampPage(page, totalItems) {
  const totalPages = Math.max(1, Math.ceil(totalItems / DAYS_PER_PAGE));
  return Math.min(Math.max(1, page), totalPages);
}

function renderPagination(containerId, page, totalItems, onPageChange) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const totalPages = Math.max(1, Math.ceil(totalItems / DAYS_PER_PAGE));
  if (totalItems <= DAYS_PER_PAGE) {
    container.innerHTML = '';
    return;
  }

  const firstItem = ((page - 1) * DAYS_PER_PAGE) + 1;
  const lastItem = Math.min(page * DAYS_PER_PAGE, totalItems);
  container.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-slate-800 pt-4">
      <span class="text-xs text-slate-500">Mostrando ${firstItem}–${lastItem} de ${totalItems} dias</span>
      <div class="flex items-center gap-2">
        <button type="button" data-page-action="prev" ${page === 1 ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-xs font-semibold text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:border-blue-500/50">Anterior</button>
        <span class="text-xs font-bold text-blue-400 px-2">Página ${page} de ${totalPages}</span>
        <button type="button" data-page-action="next" ${page === totalPages ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-xs font-semibold text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:border-blue-500/50">Próxima</button>
      </div>
    </div>
  `;

  container.onclick = (event) => {
    const action = event.target.closest('[data-page-action]')?.dataset.pageAction;
    if (action === 'prev' && page > 1) onPageChange(page - 1);
    if (action === 'next' && page < totalPages) onPageChange(page + 1);
  };
}

// ==========================================
// CALCULATION LOGIC
// ==========================================

// Helper to get green profit multiplier factor (1.0 for 100%, custom % if entered)
function getGreenFactor(bet) {
  if (bet.greenPercent !== undefined && bet.greenPercent !== null && bet.greenPercent !== '' && !isNaN(bet.greenPercent)) {
    return parseFloat(bet.greenPercent) / 100;
  }
  return 1;
}

let deferredStatsRefresh = null;

function refreshDependentViews() {
  updateGlobalStats();
  const historyContent = document.getElementById('content-history');
  const summaryContent = document.getElementById('content-bets-summary');
  if (historyContent && !historyContent.classList.contains('hidden')) renderHistory();
  if (summaryContent && !summaryContent.classList.contains('hidden')) renderBetsSummary();
}

function scheduleDependentViewsRefresh() {
  if (deferredStatsRefresh) clearTimeout(deferredStatsRefresh);
  deferredStatsRefresh = setTimeout(() => {
    deferredStatsRefresh = null;
    refreshDependentViews();
  }, 160);
}

// Update calculations for a specific bet row DOM element and save values
function updateBetCalculations(dayId, betId, rowElement, deferHeavyRefresh = false) {
  const day = trackerData.days.find(d => d.id === dayId);
  if (!day) return;
  const bet = day.bets.find(b => b.id === betId);
  if (!bet) return;

  const stakeInput = rowElement.querySelector('[data-field="stake"]');
  const oddInput = rowElement.querySelector('[data-field="odd"]');
  const statusSelect = rowElement.querySelector('[data-field="status"]');
  const bookmakerInput = rowElement.querySelector('[data-field="bookmaker"]');
  const freebetBtn = rowElement.querySelector('[data-field="freebet"]');
  const boostBtn = rowElement.querySelector('[data-field="boostActive"]');
  const boostInput = rowElement.querySelector('[data-field="boostPercent"]');
  const greenPercentInput = rowElement.querySelector('[data-field="greenPercent"]');
  const exchangeBtn = rowElement.querySelector('[data-field="exchangeType"]');

  // Update object properties in memory
  bet.stake = parseFloat(stakeInput.value) || 0;
  bet.odd = parseFloat(oddInput.value) || 0;
  bet.status = statusSelect.value;
  bet.bookmaker = bookmakerInput.value;
  bet.freebet = freebetBtn && freebetBtn.getAttribute('data-active') === 'true';
  bet.boostActive = boostBtn && boostBtn.getAttribute('data-active') === 'true';
  bet.boostPercent = parseFloat(boostInput ? boostInput.value : 0) || 0;
  bet.greenPercent = (greenPercentInput && greenPercentInput.value !== '') ? parseFloat(greenPercentInput.value) : undefined;
  bet.exchangeType = (exchangeBtn && exchangeBtn.getAttribute('data-exchange-type') === 'lay') ? 'lay' : 'back';

  // Calculate profit (% Aumentada boost multiplier applies on winning profit)
  const boostMult = (bet.boostActive && bet.boostPercent > 0) ? (1 + (bet.boostPercent / 100)) : 1;
  const greenFactor = getGreenFactor(bet);

  // Calculate liability (Responsabilidade) for Lay bets
  const liability = (bet.exchangeType === 'lay' && bet.stake > 0 && bet.odd > 1) ? (bet.stake * (bet.odd - 1)) : 0;
  bet.liability = liability;

  let profit = 0;
  if (bet.exchangeType === 'lay') {
    if (bet.freebet) {
      if (bet.status === 'green') {
        profit = (bet.stake * greenFactor) * boostMult;
      } else {
        profit = 0; // red, refunded, pending are all 0 out-of-pocket profit/loss
      }
    } else {
      if (bet.status === 'green') {
        profit = (bet.stake * greenFactor) * boostMult;
      } else if (bet.status === 'red') {
        profit = -liability;
      } else if (bet.status === 'refunded' || bet.status === 'pending') {
        profit = 0;
      }
    }
  } else {
    // Back bet
    if (bet.freebet) {
      if (bet.status === 'green') {
        profit = (((bet.stake * bet.odd) - bet.stake) * greenFactor) * boostMult;
      } else {
        profit = 0; // red, refunded, pending are all 0 out-of-pocket profit/loss
      }
    } else {
      if (bet.status === 'green') {
        profit = (((bet.stake * bet.odd) - bet.stake) * greenFactor) * boostMult;
      } else if (bet.status === 'red') {
        profit = -bet.stake;
      } else if (bet.status === 'refunded' || bet.status === 'pending') {
        profit = 0;
      }
    }
  }
  bet.profit = profit;

  // Update visual row indicators instantly
  updateBetVisuals(bet, rowElement);

  // Update day header totals and global summary
  updateDaySummary(dayId);
  if (deferHeavyRefresh) {
    scheduleDependentViewsRefresh();
  } else {
    refreshDependentViews();
  }

  // Save to persistent storage
  debouncedSaveData();
}

//// Update the visual representation (color, styling, values) of a single bet row
function updateBetVisuals(bet, rowElement) {
  const profitBadge = rowElement.querySelector('.computed-profit');
  const returnBadge = rowElement.querySelector('.computed-return');
  const statusSelect = rowElement.querySelector('[data-field="status"]');
  const freebetBtn = rowElement.querySelector('[data-field="freebet"]');
  const boostBtn = rowElement.querySelector('[data-field="boostActive"]');
  const boostInput = rowElement.querySelector('[data-field="boostPercent"]');
  const boostSpan = boostInput ? boostInput.parentNode.querySelector('span') : null;
  const exchangeBtn = rowElement.querySelector('[data-field="exchangeType"]');
  const liabilityBadge = rowElement.querySelector('.liability-badge');

  if (exchangeBtn) {
    const isLay = bet.exchangeType === 'lay';
    exchangeBtn.setAttribute('data-exchange-type', isLay ? 'lay' : 'back');
    exchangeBtn.setAttribute('title', isLay ? 'Aposta LAY (Contra o evento)' : 'Aposta BACK (A favor do evento)');
    if (isLay) {
      exchangeBtn.className = 'btn-exchange-type flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-xl border text-xs font-bold transition-all bg-pink-500/20 border-pink-500/40 text-pink-300 shadow-sm shadow-pink-500/10 w-full';
      exchangeBtn.innerHTML = `<i data-lucide="shield-alert" class="w-3.5 h-3.5 text-pink-400"></i><span class="font-extrabold tracking-wide">LAY</span>`;
    } else {
      exchangeBtn.className = 'btn-exchange-type flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-xl border text-xs font-bold transition-all bg-sky-500/20 border-sky-500/40 text-sky-400 shadow-sm shadow-sky-500/10 w-full';
      exchangeBtn.innerHTML = `<i data-lucide="trending-up" class="w-3.5 h-3.5 text-sky-400"></i><span class="font-extrabold tracking-wide">BACK</span>`;
    }
    if (window.lucide) {
      window.lucide.createIcons({ root: exchangeBtn });
    }
  }

  if (liabilityBadge) {
    if (bet.exchangeType === 'lay' && bet.stake > 0 && bet.odd > 1) {
      const liability = bet.stake * (bet.odd - 1);
      liabilityBadge.textContent = `Risco: ${formatCurrency(liability)}`;
      liabilityBadge.className = 'liability-badge text-[10px] text-pink-400 font-semibold mt-1 block truncate';
    } else {
      liabilityBadge.textContent = '';
      liabilityBadge.className = 'liability-badge text-[10px] hidden';
    }
  }

  // Compute total return for individual bet
  let betReturn = 0;
  const stake = bet.stake || 0;
  const odd = bet.odd || 0;
  const isLay = bet.exchangeType === 'lay';
  const liability = (isLay && stake > 0 && odd > 1) ? (stake * (odd - 1)) : 0;
  const boostMult = (bet.boostActive && bet.boostPercent > 0) ? (1 + (bet.boostPercent / 100)) : 1;

  if (bet.status === 'green') {
    if (isLay) {
      betReturn = bet.freebet ? bet.profit : (liability + bet.profit);
    } else {
      betReturn = bet.freebet ? bet.profit : (stake + bet.profit);
    }
  } else if (bet.status === 'refunded' && !bet.freebet) {
    betReturn = isLay ? liability : stake;
  }

  if (returnBadge) {
    if (bet.status === 'green' || (bet.status === 'refunded' && betReturn > 0)) {
      returnBadge.textContent = `Retorno: ${formatCurrency(betReturn)}`;
      returnBadge.className = 'computed-return text-[10px] text-emerald-400/90 font-medium whitespace-nowrap block';
    } else {
      returnBadge.textContent = '';
      returnBadge.className = 'computed-return text-[10px] hidden';
    }
  }

  if (profitBadge) {
    profitBadge.textContent = (bet.profit >= 0 ? '+' : '') + formatCurrency(bet.profit);
    profitBadge.className = 'computed-profit text-sm font-semibold tracking-tight whitespace-nowrap';
    if (bet.status === 'green') {
      profitBadge.classList.add('text-emerald-500');
    } else if (bet.status === 'red') {
      if (bet.freebet) {
        profitBadge.classList.add('text-slate-450'); // Loss of freebet has 0 profit, colored neutral
      } else {
        profitBadge.classList.add('text-rose-500');
      }
    } else if (bet.status === 'refunded') {
      profitBadge.classList.add('text-slate-400');
    } else {
      profitBadge.classList.add('text-amber-500');
    }
  }

  if (statusSelect) {
    statusSelect.className = 'w-full bg-slate-950/60 border rounded-xl px-2.5 py-1.5 text-sm text-slate-200 focus:border-blue-500 focus:bg-slate-950 cursor-pointer shadow-inner';
    if (bet.status === 'green') {
      statusSelect.classList.add('border-emerald-500/40', 'text-emerald-450');
    } else if (bet.status === 'red') {
      statusSelect.classList.add('border-rose-500/40', 'text-rose-450');
    } else if (bet.status === 'refunded') {
      statusSelect.classList.add('border-slate-800', 'text-slate-400');
    } else {
      statusSelect.classList.add('border-amber-500/30', 'text-amber-400');
    }
  }

  if (freebetBtn) {
    freebetBtn.setAttribute('data-active', bet.freebet ? 'true' : 'false');
    if (bet.freebet) {
      freebetBtn.className = 'btn-freebet flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all bg-blue-600/20 border-blue-500/40 text-blue-300 shadow-sm';
    } else {
      freebetBtn.className = 'btn-freebet flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700';
    }
  }

  if (boostBtn) {
    boostBtn.setAttribute('data-active', bet.boostActive ? 'true' : 'false');
    if (bet.boostActive) {
      boostBtn.className = 'btn-boost flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-bold transition-all bg-amber-500/20 border-amber-500/40 text-amber-400 shadow-sm';
    } else {
      boostBtn.className = 'btn-boost flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-bold transition-all bg-slate-950/60 border-slate-800 text-slate-400 hover:text-amber-400';
    }
  }

  if (boostInput) {
    boostInput.disabled = !bet.boostActive;
  }

  if (boostSpan) {
    boostSpan.className = `absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-semibold ${bet.boostActive ? 'text-amber-400' : 'text-slate-600'} pointer-events-none`;
  }

  const greenPercentInput = rowElement.querySelector('[data-field="greenPercent"]');
  const greenPercentSpan = greenPercentInput ? greenPercentInput.parentNode.querySelector('span') : null;

  if (greenPercentInput) {
    const isGreen = bet.status === 'green';
    greenPercentInput.disabled = !isGreen;
    if (greenPercentSpan) {
      greenPercentSpan.className = `absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] font-semibold ${isGreen ? 'text-emerald-400' : 'text-slate-600'} pointer-events-none`;
    }
  }
}

// Recompute the totals for a specific day and update its UI header elements
function updateDaySummary(dayId, targetDayElement = null) {
  const day = trackerData.days.find(d => d.id === dayId);
  if (!day) return;

  const dayElement = targetDayElement || document.querySelector(`[data-day-id="${dayId}"]`);
  if (!dayElement) return;

  let totalWagered = 0;
  let totalReturn = 0;
  let netProfit = 0;

  day.bets.forEach(bet => {
    const stake = bet.stake || 0;
    const odd = bet.odd || 0;
    const isLay = bet.exchangeType === 'lay';
    const liability = (isLay && stake > 0 && odd > 1) ? (stake * (odd - 1)) : 0;
    const riskAmount = isLay ? liability : stake;
    const boostMult = (bet.boostActive && bet.boostPercent > 0) ? (1 + (bet.boostPercent / 100)) : 1;

    // Freebets don't risk personal pocket money, so we exclude stake/liability from wagered
    if (!bet.freebet) {
      totalWagered += riskAmount;
    }
    netProfit += bet.profit || 0;

    if (bet.status === 'green') {
      if (isLay) {
        if (bet.freebet) {
          totalReturn += bet.profit;
        } else {
          totalReturn += liability + bet.profit;
        }
      } else {
        if (bet.freebet) {
          totalReturn += bet.profit;
        } else {
          totalReturn += stake + bet.profit;
        }
      }
    } else if (bet.status === 'refunded' && !bet.freebet) {
      totalReturn += riskAmount;
    }
  });

  const wageredEl = dayElement.querySelector('.day-total-wagered');
  const returnEl = dayElement.querySelector('.day-total-return');
  const profitEl = dayElement.querySelector('.day-net-profit');

  if (wageredEl) wageredEl.textContent = formatCurrency(totalWagered);
  if (returnEl) {
    returnEl.textContent = formatCurrency(totalReturn);
    const returnColor = totalReturn > totalWagered ? 'text-emerald-400' : (totalReturn < totalWagered ? 'text-rose-400' : 'text-slate-400');
    returnEl.className = `${returnColor} day-total-return whitespace-nowrap font-semibold`;
  }

  if (profitEl) {
    profitEl.textContent = (netProfit >= 0 ? '+' : '') + formatCurrency(netProfit);
    profitEl.className = 'day-net-profit font-semibold whitespace-nowrap';
    if (netProfit > 0) {
      profitEl.classList.add('text-emerald-500');
    } else if (netProfit < 0) {
      profitEl.classList.add('text-rose-500');
    } else {
      profitEl.classList.add('text-slate-400');
    }
  }

  if (day && day.date) {
    updateDateGroupHeader(day.date);
  }
}

// Update outer date group card header totals if present
function updateDateGroupHeader(dateKey) {
  const dateCard = document.querySelector(`[data-date-key="${dateKey}"]`);
  if (!dateCard) return;

  const sessions = trackerData.days.filter(d => (d.date || '') === dateKey);

  let dateWagered = 0;
  let dateReturn = 0;
  let dateNetProfit = 0;

  sessions.forEach(day => {
    (day.bets || []).forEach(bet => {
      const stake = bet.stake || 0;
      const odd = bet.odd || 0;
      const isLay = bet.exchangeType === 'lay';
      const liability = (isLay && stake > 0 && odd > 1) ? (stake * (odd - 1)) : 0;
      const riskAmount = isLay ? liability : stake;
      const boostMult = (bet.boostActive && bet.boostPercent > 0) ? (1 + (bet.boostPercent / 100)) : 1;

      if (!bet.freebet) {
        dateWagered += riskAmount;
      }
      dateNetProfit += bet.profit || 0;

      if (bet.status === 'green') {
        if (isLay) {
          dateReturn += bet.freebet ? bet.profit : (liability + bet.profit);
        } else {
          dateReturn += bet.freebet ? bet.profit : (stake + bet.profit);
        }
      } else if (bet.status === 'refunded' && !bet.freebet) {
        dateReturn += riskAmount;
      }
    });
  });

  const wageredEl = dateCard.querySelector('.date-total-wagered');
  const returnEl = dateCard.querySelector('.date-total-return');
  const profitEl = dateCard.querySelector('.date-net-profit');

  if (wageredEl) wageredEl.textContent = formatCurrency(dateWagered);
  if (returnEl) {
    returnEl.textContent = formatCurrency(dateReturn);
    const returnColor = dateReturn > dateWagered ? 'text-emerald-400' : (dateReturn < dateWagered ? 'text-rose-400' : 'text-slate-400');
    returnEl.className = `${returnColor} font-semibold date-total-return`;
  }

  if (profitEl) {
    profitEl.textContent = (dateNetProfit >= 0 ? '+' : '') + formatCurrency(dateNetProfit);
    profitEl.className = `date-net-profit font-bold ${dateNetProfit > 0 ? 'text-emerald-400' : (dateNetProfit < 0 ? 'text-rose-400' : 'text-slate-400')}`;
  }
}

// Recompute global statistics across all days and update the dashboard cards
function updateGlobalStats() {
  let totalWagered = 0;
  let totalReturn = 0;
  let netProfit = 0;
  let totalFreebetUsed = 0;
  
  let activeWagered = 0;
  let activeDaysCount = 0;
  const totalDaysCount = trackerData.days.length;

  let resolvedBetsCount = 0;
  let wonBetsCount = 0;

  trackerData.days.forEach(day => {
    const isDayActive = day.active !== false;
    let dayWagered = 0;

    day.bets.forEach(bet => {
      const stake = bet.stake || 0;
      const odd = bet.odd || 0;
      const isLay = bet.exchangeType === 'lay';
      const liability = (isLay && stake > 0 && odd > 1) ? (stake * (odd - 1)) : 0;
      const riskAmount = isLay ? liability : stake;
      
      if (!bet.freebet) {
        totalWagered += riskAmount;
        dayWagered += riskAmount;
      } else {
        totalFreebetUsed += stake;
      }
      netProfit += bet.profit || 0;

      if (bet.status === 'green') {
        const gf = getGreenFactor(bet);
        if (isLay) {
          if (bet.freebet) {
            totalReturn += bet.profit; // Net winnings returned
          } else {
            totalReturn += liability + bet.profit; // Returned liability + net profit
          }
        } else {
          if (bet.freebet) {
            totalReturn += bet.profit; // Net winnings returned
          } else {
            totalReturn += stake + bet.profit; // Full return (stake + net profit)
          }
        }
        resolvedBetsCount++;
        wonBetsCount += (gf < 1 ? gf : 1);
      } else if (bet.status === 'red') {
        resolvedBetsCount++;
      } else if (bet.status === 'refunded') {
        if (!bet.freebet) {
          totalReturn += riskAmount; // Refunded stake or liability returned to pocket
        }
        // Refunded is not considered for win rate calculation
      } else if (bet.status === 'pending') {
        // Pending stake remains locked, return is 0
      }
    });

    if (isDayActive) {
      activeWagered += dayWagered;
      activeDaysCount++;
    }
  });

  // Win Rate: (Won Bets / Resolved Bets) * 100
  let winRate = 0;
  if (resolvedBetsCount > 0) {
    winRate = (wonBetsCount / resolvedBetsCount) * 100;
  }

  // DOM Elements
  const profitValEl = document.getElementById('stat-net-profit');
  const profitSubEl = document.getElementById('stat-net-profit-subtext');
  const profitCardEl = document.getElementById('card-net-profit');
  const profitIconContainerEl = document.getElementById('icon-container-net-profit');
  
  const wageredValEl = document.getElementById('stat-total-wagered');
  const returnValEl = document.getElementById('stat-total-return');
  
  const activeBalanceValEl = document.getElementById('stat-active-balance');
  const activeBalanceSubEl = document.getElementById('stat-active-balance-subtext');
  const activeBalanceCardEl = document.getElementById('card-active-balance');
  const activeBalanceIconEl = document.getElementById('icon-container-active-balance');

  const winRateValEl = document.getElementById('stat-win-rate');
  const winRateSubEl = document.getElementById('stat-win-rate-sub');

  if (wageredValEl) wageredValEl.textContent = formatCurrency(totalWagered);
  if (returnValEl) {
    returnValEl.textContent = formatCurrency(totalReturn);
    const returnColorClass = totalReturn > totalWagered ? 'text-emerald-400' : (totalReturn < totalWagered ? 'text-rose-400' : 'text-slate-100');
    returnValEl.className = `text-2xl font-bold tracking-tight ${returnColorClass}`;
  }
  
  // Saldo Ativo (Sincronizado com o interruptor das sessões)
  if (activeBalanceValEl) {
    activeBalanceValEl.textContent = formatCurrency(activeWagered);
  }

  if (activeBalanceSubEl) {
    if (totalDaysCount === 0) {
      if (activeBalanceValEl) activeBalanceValEl.className = 'text-2xl lg:text-3xl font-extrabold tracking-tight text-slate-400';
      if (activeBalanceIconEl) activeBalanceIconEl.className = 'p-2 bg-slate-800/80 rounded-lg text-slate-400';
      if (activeBalanceCardEl) activeBalanceCardEl.className = 'glass-card rounded-xl p-5 border border-slate-800 flex flex-col justify-between hover:border-slate-700 transition-all duration-300';
      activeBalanceSubEl.innerHTML = '<span class="text-slate-400 text-xs font-medium">Nenhum dia cadastrado</span>';
    } else if (activeDaysCount > 0) {
      if (activeBalanceValEl) activeBalanceValEl.className = 'text-2xl lg:text-3xl font-extrabold tracking-tight text-emerald-400';
      if (activeBalanceIconEl) activeBalanceIconEl.className = 'p-2 bg-emerald-950/80 rounded-lg text-emerald-400';
      if (activeBalanceCardEl) activeBalanceCardEl.className = 'glass-card rounded-xl p-5 border border-emerald-500/30 flex flex-col justify-between transition-all duration-300 glow-green bg-emerald-950/10';
      activeBalanceSubEl.innerHTML = `<span class="flex items-center gap-1.5 text-emerald-400 text-xs font-medium"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"></span> ${activeDaysCount} de ${totalDaysCount} dia(s) com saldo ativo</span>`;
    } else {
      if (activeBalanceValEl) activeBalanceValEl.className = 'text-2xl lg:text-3xl font-extrabold tracking-tight text-slate-300';
      if (activeBalanceIconEl) activeBalanceIconEl.className = 'p-2 bg-slate-800/80 rounded-lg text-slate-400';
      if (activeBalanceCardEl) activeBalanceCardEl.className = 'glass-card rounded-xl p-5 border border-slate-800 flex flex-col justify-between hover:border-slate-700 transition-all duration-300';
      activeBalanceSubEl.innerHTML = '<span class="flex items-center gap-1.5 text-slate-400 text-xs font-medium"><span class="w-1.5 h-1.5 rounded-full bg-slate-500 inline-block"></span> Nenhuma sessão ativa no momento</span>';
    }
  }

  // Net Profit Card visual rule
  if (profitValEl && profitCardEl && profitIconContainerEl) {
    profitValEl.textContent = (netProfit >= 0 ? '+' : '') + formatCurrency(netProfit);
    
    // Reset classes
    profitCardEl.className = 'lg:col-span-1 glass-card rounded-xl p-5 border flex flex-col justify-between transition-all duration-300';
    profitIconContainerEl.className = 'p-2 rounded-lg';
    
    if (netProfit > 0) {
      profitCardEl.classList.add('border-emerald-500/30', 'glow-green', 'bg-emerald-950/10');
      profitValEl.className = 'text-2xl lg:text-3xl font-extrabold tracking-tight text-emerald-400';
      profitSubEl.innerHTML = `<span class="flex items-center gap-1 text-emerald-400 text-xs font-medium"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="inline-block"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline><polyline points="16 7 22 7 22 13"></polyline></svg> Saldo Positivo</span>`;
      profitIconContainerEl.className = 'p-2 rounded-lg bg-emerald-950/80 text-emerald-400';
    } else if (netProfit < 0) {
      profitCardEl.classList.add('border-rose-500/30', 'glow-red', 'bg-rose-950/10');
      profitValEl.className = 'text-2xl lg:text-3xl font-extrabold tracking-tight text-rose-400';
      profitSubEl.innerHTML = `<span class="flex items-center gap-1 text-rose-400 text-xs font-medium"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="inline-block"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"></polyline><polyline points="16 17 22 17 22 11"></polyline></svg> Saldo Negativo</span>`;
      profitIconContainerEl.className = 'p-2 rounded-lg bg-rose-950/80 text-rose-400';
    } else {
      profitCardEl.classList.add('border-slate-800', 'glow-neutral');
      profitValEl.className = 'text-2xl lg:text-3xl font-extrabold tracking-tight text-slate-100';
      profitSubEl.innerHTML = `<span class="text-slate-400 text-xs">Sem lucros ou prejuízos</span>`;
      profitIconContainerEl.className = 'p-2 rounded-lg bg-slate-800/80 text-slate-400';
    }
  }

  // Update Freebet Total Badge
  const freebetCountText = document.getElementById('freebet-count-text');
  if (freebetCountText) {
    freebetCountText.textContent = `${formatCurrency(totalFreebetUsed)} em freebet`;
  }

  // Refresh Freebets tab if active
  const contentFreebetsEl = document.getElementById('content-freebets');
  if (contentFreebetsEl && !contentFreebetsEl.classList.contains('hidden')) {
    const inputSearchFreebetDays = document.getElementById('input-search-freebet-days');
    renderFreebetDays(inputSearchFreebetDays ? inputSearchFreebetDays.value : '');
  }

  const contentGoalsEl = document.getElementById('content-goals');
  if (contentGoalsEl && !contentGoalsEl.classList.contains('hidden')) {
    renderGoals();
  }

  const pnlModal = document.getElementById('modal-pnl');
  if (pnlModal && !pnlModal.classList.contains('hidden')) {
    renderPnlCalendar();
  }

  // Update global capital totals
  updateGlobalCapital();
}

// ==========================================
// GOAL TRACKING
// ==========================================

function getGoalProgress() {
  ensureTrackerDataShape();
  const { amount, startDate } = trackerData.goal;
  let profit = 0;

  if (startDate) {
    (trackerData.days || []).forEach(day => {
      if ((day.date || '') < startDate) return;
      (day.bets || []).forEach(bet => {
        profit += parseFloat(bet.profit) || 0;
      });
    });
  }

  return { amount, startDate, profit };
}

function renderGoals() {
  const amountInput = document.getElementById('goal-target-amount');
  const dateInput = document.getElementById('goal-start-date');
  const currentEl = document.getElementById('goal-current-value');
  const targetEl = document.getElementById('goal-target-value');
  const percentEl = document.getElementById('goal-percent');
  const statusEl = document.getElementById('goal-status-text');
  const barEl = document.getElementById('goal-progress-bar');
  const startLabelEl = document.getElementById('goal-start-date-label');
  const remainingEl = document.getElementById('goal-remaining-value');
  const progressEl = barEl?.parentElement;
  if (!currentEl || !targetEl || !percentEl || !statusEl || !barEl) return;

  const { amount, startDate, profit } = getGoalProgress();
  if (amountInput && document.activeElement !== amountInput) amountInput.value = amount || '';
  if (dateInput && document.activeElement !== dateInput) dateInput.value = startDate || '';

  const rawPercent = amount > 0 ? (profit / amount) * 100 : 0;
  const visualPercent = Math.max(0, Math.min(rawPercent, 100));
  const remaining = Math.max(amount - profit, 0);
  const completed = amount > 0 && profit >= amount;

  currentEl.textContent = `${profit >= 0 ? '+' : ''}${formatCurrency(profit)}`;
  currentEl.className = `text-3xl md:text-4xl font-extrabold ${profit < 0 ? 'text-rose-400' : 'text-slate-100'}`;
  targetEl.textContent = `de ${formatCurrency(amount)}`;
  percentEl.textContent = `${Math.max(0, rawPercent).toFixed(1)}%`;
  percentEl.className = `text-2xl font-extrabold ${completed ? 'text-cyan-300' : 'text-emerald-400'}`;
  barEl.style.width = `${visualPercent}%`;
  barEl.className = `h-full rounded-full transition-all duration-500 ${completed ? 'bg-gradient-to-r from-cyan-500 via-emerald-400 to-amber-300' : 'bg-gradient-to-r from-emerald-600 via-emerald-500 to-cyan-400'}`;
  if (progressEl) progressEl.setAttribute('aria-valuenow', String(Math.round(visualPercent)));
  if (startLabelEl) startLabelEl.textContent = startDate ? formatDate(startDate) : 'não definido';
  if (remainingEl) remainingEl.textContent = amount > 0 ? (completed ? `Meta superada em ${formatCurrency(profit - amount)}` : `Faltam ${formatCurrency(remaining)}`) : 'Informe um valor para a meta';

  if (!amount || !startDate) {
    statusEl.textContent = 'Defina o valor e a data inicial para começar.';
  } else if (completed) {
    statusEl.textContent = 'Meta alcançada — continue para superar o objetivo.';
  } else if (profit < 0) {
    statusEl.textContent = 'O resultado líquido ainda está negativo neste período.';
  } else {
    statusEl.textContent = 'O lucro líquido confirmado desde a data inicial conta para esta meta.';
  }
}

function saveGoal() {
  const amountInput = document.getElementById('goal-target-amount');
  const dateInput = document.getElementById('goal-start-date');
  if (!amountInput || !dateInput) return;

  const amount = Math.max(0, parseFloat(amountInput.value) || 0);
  const startDate = dateInput.value || '';
  if (amount > 0 && !startDate) {
    alert('Escolha a data a partir da qual os lucros devem contar para a meta.');
    dateInput.focus();
    return;
  }

  ensureTrackerDataShape();
  trackerData.goal = { amount, startDate };
  renderGoals();
  debouncedSaveData();
}

// ==========================================
// DOM ELEMENT CREATORS
// ==========================================

// Create DOM elements for a Betting Day
function createDayElement(day) {
  const div = document.createElement('div');
  div.className = 'dashboard-session glass-card rounded-xl border border-slate-800 overflow-hidden shadow-sm transition-all-300 animate-slide-down';
  div.setAttribute('data-day-id', day.id);

  div.innerHTML = `
    <div class="day-header flex flex-col md:flex-row md:items-center justify-between gap-3 p-3.5 md:p-4 bg-slate-900/30 hover:bg-slate-900/60 transition-colors cursor-pointer select-none">
      
      <!-- Esquerda: Chevron, Data, Obs, Editar -->
      <div class="flex items-center justify-between md:justify-start gap-2.5 min-w-0 flex-1">
        <div class="flex items-center gap-2 min-w-0">
          <button class="btn-toggle-expand p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-200 transition-colors shrink-0">
            <i data-lucide="chevron-right" class="w-5 h-5 transition-transform duration-200 ${day.expanded ? 'rotate-90' : ''}"></i>
          </button>

          <span class="text-sm font-bold text-slate-100 flex items-center gap-1.5 shrink-0">
            <i data-lucide="calendar" class="w-4 h-4 text-blue-400"></i>
            ${formatDate(day.date)}
          </span>

          ${day.notes ? `
          <span class="text-xs px-2.5 py-0.5 bg-slate-950 border border-slate-800 rounded-full text-slate-300 truncate max-w-[120px] sm:max-w-[240px] md:max-w-[320px]" title="${escapeHTML(day.notes)}">
            Obs: <span class="font-medium text-slate-400">${escapeHTML(day.notes)}</span>
          </span>
          ` : ''}

          <button class="btn-edit-day text-slate-500 hover:text-blue-400 p-1 hover:bg-slate-800 rounded-lg transition-colors shrink-0" title="Editar Data/Observações">
            <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>

      <!-- Centro: Apostado, Retorno Total e Resultado -->
      <div class="grid grid-cols-3 md:flex items-center justify-between md:justify-center gap-2 md:gap-3 text-xs md:w-[480px] md:min-w-[480px] shrink-0 py-2 md:py-0 px-2 md:px-4 bg-slate-950/60 md:bg-transparent rounded-lg md:rounded-none border md:border-y-0 md:border-x border-slate-800/60 text-center md:text-left whitespace-nowrap">
        <div class="flex flex-col md:flex-row md:items-center gap-0.5 md:gap-1">
          <span class="text-slate-400 text-[10px] md:text-xs uppercase md:normal-case font-medium">Apostado</span>
          <strong class="text-slate-200 day-total-wagered font-bold">${formatCurrency(0)}</strong>
        </div>
        <div class="flex flex-col md:flex-row md:items-center gap-0.5 md:gap-1 border-x md:border-x-0 border-slate-800 px-1 md:px-0">
          <span class="text-slate-400 text-[10px] md:text-xs uppercase md:normal-case font-medium">Retorno</span>
          <strong class="text-slate-200 day-total-return font-bold">${formatCurrency(0)}</strong>
        </div>
        <div class="flex flex-col md:flex-row md:items-center gap-0.5 md:gap-1">
          <span class="text-slate-400 text-[10px] md:text-xs uppercase md:normal-case font-medium">Resultado</span>
          <strong class="day-net-profit text-slate-200 font-extrabold">${formatCurrency(0)}</strong>
        </div>
      </div>

      <!-- Direita: Status, Duplicar, Nova Aposta, Excluir -->
      <div class="flex items-center gap-2 shrink-0 justify-between md:justify-end border-t md:border-t-0 border-slate-900/60 pt-2 md:pt-0">
        <div class="flex items-center gap-1.5">
          <button class="btn-toggle-day-status flex items-center justify-center p-1.5 rounded-lg border transition-all duration-200 cursor-pointer ${day.active !== false ? 'bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-400 border-emerald-500/25' : 'bg-slate-800/60 hover:bg-slate-800 text-slate-400 border-slate-700/50'}" title="Status: ${day.active !== false ? 'Ativo' : 'Inativo'}">
            ${day.active !== false ? 
              `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><rect width="20" height="12" x="2" y="6" rx="6" ry="6"></rect><circle cx="16" cy="12" r="2"></circle></svg>` : 
              `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><rect width="20" height="12" x="2" y="6" rx="6" ry="6"></rect><circle cx="8" cy="12" r="2"></circle></svg>`
            }
          </button>
          <button class="btn-duplicate-day text-slate-500 hover:text-blue-400 p-1.5 hover:bg-slate-800 rounded-lg transition-colors" title="Duplicar Dia Todo">
            <i data-lucide="copy" class="w-4 h-4"></i>
          </button>
          <button class="btn-delete-day text-slate-500 hover:text-rose-400 p-1.5 hover:bg-slate-800 rounded-lg transition-colors" title="Excluir Dia">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>

        <button class="btn-add-bet flex items-center gap-1.5 bg-blue-600/15 hover:bg-blue-600/25 text-blue-300 border border-blue-500/30 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors shadow-sm">
          <i data-lucide="plus" class="w-3.5 h-3.5"></i>
          Nova Aposta
        </button>
      </div>
    </div>
    
    <div class="day-content border-t border-slate-900/60 bg-slate-950/20 ${day.expanded ? '' : 'hidden'}">
      <div class="hidden md:grid grid-cols-12 gap-2.5 items-center py-2.5 px-4 bg-slate-900/15 border-b border-slate-900/50 text-[10px] font-bold text-slate-500 tracking-wider uppercase">
        <div class="col-span-2">Casa de Aposta</div>
        <div class="col-span-1 text-center">Tipo</div>
        <div class="col-span-1 text-center">Freebet</div>
        <div class="col-span-2">Stake (Valor)</div>
        <div class="col-span-1">Odd</div>
        <div class="col-span-1 text-center">% Aum.</div>
        <div class="col-span-1 text-center">% Green</div>
        <div class="col-span-1">Status</div>
        <div class="col-span-1 text-right">Resultado</div>
        <div class="col-span-1"></div>
      </div>
      
      <div class="bets-container divide-y divide-slate-900/40">
        <!-- Bets will go here -->
      </div>
    </div>
  `;
  return div;
}

// Create DOM elements for a Bet Row inside a Day
function createBetRowElement(dayId, bet) {
  const div = document.createElement('div');
  div.className = 'grid grid-cols-2 md:grid-cols-12 gap-2.5 md:gap-3 items-center p-3.5 md:p-4 border-b border-slate-900/40 bg-slate-900/10 hover:bg-slate-900/20 transition-colors rounded-xl md:rounded-none my-2 md:my-0 mx-1 md:mx-0 border md:border-0 md:border-b border-slate-800/40';
  div.setAttribute('data-day-id', dayId);
  div.setAttribute('data-bet-id', bet.id);

  const isLay = bet.exchangeType === 'lay';

  div.innerHTML = `
    <!-- Casa de Aposta -->
    <div class="col-span-2 md:col-span-2 flex flex-col">
      <label class="text-[9px] text-slate-500 uppercase font-bold md:hidden mb-1">Casa de Aposta</label>
      <input type="text" data-field="bookmaker" value="${escapeHTML(bet.bookmaker || '')}" placeholder="Ex: Betfair / Bet365" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs md:text-sm text-slate-200 focus:border-blue-500 focus:bg-slate-950 shadow-inner">
    </div>

    <!-- Tipo (Exchange Back / Lay) -->
    <div class="col-span-1 md:col-span-1 flex flex-col items-start md:items-center">
      <label class="text-[9px] text-slate-500 uppercase font-bold md:hidden mb-1">Tipo</label>
      <button type="button" data-field="exchangeType" data-exchange-type="${isLay ? 'lay' : 'back'}" class="btn-exchange-type flex items-center justify-center gap-1 px-2 py-1.5 rounded-xl border text-xs font-bold transition-all w-full ${isLay ? 'bg-pink-500/20 border-pink-500/40 text-pink-300 shadow-sm shadow-pink-500/10' : 'bg-sky-500/20 border-sky-500/40 text-sky-400 shadow-sm shadow-sky-500/10'}" title="${isLay ? 'Aposta LAY (Contra o evento)' : 'Aposta BACK (A favor do evento)'}">
        <i data-lucide="${isLay ? 'shield-alert' : 'trending-up'}" class="w-3.5 h-3.5 ${isLay ? 'text-pink-400' : 'text-sky-400'}"></i>
        <span class="font-extrabold tracking-wide">${isLay ? 'LAY' : 'BACK'}</span>
      </button>
    </div>

    <!-- Freebet -->
    <div class="col-span-1 md:col-span-1 flex flex-col items-start md:items-center">
      <label class="text-[9px] text-slate-500 uppercase font-bold md:hidden mb-1">Freebet</label>
      <button type="button" data-field="freebet" data-active="${bet.freebet ? 'true' : 'false'}" class="btn-freebet flex items-center justify-center gap-1 px-2 py-1.5 rounded-xl border text-xs font-semibold transition-all w-full" title="Marcar como Aposta Grátis">
        <i data-lucide="gift" class="w-3.5 h-3.5"></i>
        <span class="inline">Grátis</span>
      </button>
    </div>

    <!-- Stake -->
    <div class="col-span-1 md:col-span-2 flex flex-col">
      <label class="text-[9px] text-slate-500 uppercase font-bold md:hidden mb-1">Stake (R$)</label>
      <div class="relative">
        <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-500">R$</span>
        <input type="number" data-field="stake" value="${bet.stake || ''}" placeholder="0,00" step="0.01" min="0" class="w-full bg-slate-950 border border-slate-800 rounded-xl pl-7 pr-2.5 py-1.5 text-xs md:text-sm text-slate-200 focus:border-blue-500 focus:bg-slate-950 shadow-inner font-medium">
      </div>
      <span class="liability-badge text-[10px] text-pink-400 font-semibold mt-1 hidden truncate"></span>
    </div>
    
    <!-- Odd -->
    <div class="col-span-1 md:col-span-1 flex flex-col">
      <label class="text-[9px] text-slate-500 uppercase font-bold md:hidden mb-1">Odd</label>
      <input type="number" data-field="odd" value="${bet.odd || ''}" placeholder="1.85" step="0.01" min="1" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-xs md:text-sm text-slate-200 focus:border-blue-500 focus:bg-slate-950 shadow-inner font-medium">
    </div>
    
    <!-- % Aumentada -->
    <div class="col-span-1 md:col-span-1 flex flex-col">
      <label class="text-[9px] text-slate-500 uppercase font-bold md:hidden mb-1">% Aumentada</label>
      <div class="flex items-center gap-1">
        <button type="button" data-field="boostActive" data-active="${bet.boostActive ? 'true' : 'false'}" class="btn-boost flex items-center justify-center p-1.5 rounded-xl border text-xs font-bold transition-all ${bet.boostActive ? 'bg-amber-500/20 border-amber-500/40 text-amber-400 shadow-sm shadow-amber-500/10' : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-amber-400'}" title="Ativar % Aumentada (Boost)">
          <i data-lucide="percent" class="w-3.5 h-3.5"></i>
        </button>
        <div class="relative flex-1 min-w-0">
          <input type="number" data-field="boostPercent" value="${bet.boostPercent || ''}" placeholder="0%" min="0" step="1" ${bet.boostActive ? '' : 'disabled'} class="w-full bg-slate-950 border border-slate-800 rounded-xl pl-1.5 pr-4 py-1.5 text-xs text-slate-200 focus:border-amber-500 focus:bg-slate-950 shadow-inner disabled:opacity-40 disabled:cursor-not-allowed transition-all font-medium">
          <span class="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] font-semibold ${bet.boostActive ? 'text-amber-400' : 'text-slate-600'} pointer-events-none">%</span>
        </div>
      </div>
    </div>

    <!-- % Green (Cashout %) -->
    <div class="col-span-1 md:col-span-1 flex flex-col">
      <label class="text-[9px] text-slate-500 uppercase font-bold md:hidden mb-1">% Green</label>
      <div class="relative flex items-center">
        <input type="number" data-field="greenPercent" value="${bet.greenPercent !== undefined && bet.greenPercent !== null ? bet.greenPercent : ''}" placeholder="100%" min="0" max="1000" step="1" ${ bet.status === 'green' ? '' : 'disabled' } class="w-full bg-slate-950 border border-slate-800 rounded-xl pl-2 pr-4 py-1.5 text-xs text-slate-200 focus:border-emerald-500 focus:bg-slate-950 shadow-inner disabled:opacity-40 disabled:cursor-not-allowed font-medium transition-all" title="% Ganha do Green (Ex: 50% para meio green, 75%, 100%)">
        <span class="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] font-semibold ${ bet.status === 'green' ? 'text-emerald-400' : 'text-slate-600' } pointer-events-none">%</span>
      </div>
    </div>
    
    <!-- Status -->
    <div class="col-span-1 md:col-span-1 flex flex-col">
      <label class="text-[9px] text-slate-500 uppercase font-bold md:hidden mb-1">Status</label>
      <select data-field="status" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-1.5 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:bg-slate-950 cursor-pointer shadow-inner">
        <option value="pending" ${bet.status === 'pending' ? 'selected' : ''}>🟡 Pendente</option>
        <option value="green" ${bet.status === 'green' ? 'selected' : ''}>🟢 Green</option>
        <option value="red" ${bet.status === 'red' ? 'selected' : ''}>🔴 Red</option>
        <option value="refunded" ${bet.status === 'refunded' ? 'selected' : ''}>⚪ Reembolso</option>
      </select>
    </div>
    
    <!-- Lucro / Retorno Calculado & Deletar -->
    <div class="col-span-1 md:col-span-1 flex flex-col items-end text-right justify-center">
      <label class="text-[9px] text-slate-500 uppercase font-bold md:hidden mb-0.5">Resultado</label>
      <span class="computed-profit text-xs md:text-sm font-semibold tracking-tight whitespace-nowrap">R$ 0,00</span>
      <span class="computed-return text-[10px] text-emerald-400/90 font-medium whitespace-nowrap hidden"></span>
    </div>

    <!-- Ações -->
    <div class="col-span-2 md:col-span-1 flex justify-end md:justify-center border-t md:border-t-0 border-slate-900/40 pt-2 md:pt-0 mt-1 md:mt-0">
      <button class="btn-delete-bet text-slate-500 hover:text-rose-500 p-1.5 hover:bg-slate-900 rounded-lg transition-colors shadow-sm" title="Excluir Aposta">
        <i data-lucide="trash-2" class="w-4 h-4 md:w-4.5 md:h-4.5"></i>
      </button>
    </div>
  `;
  return div;
}


// ==========================================
// RENDER & SCREEN REFRESH FUNCTIONS
// ==========================================

function renderAllDays(filterQuery = '') {
  const container = document.getElementById('days-container');
  const emptyState = document.getElementById('empty-state');
  const daysCount = document.getElementById('days-count');

  if (!container) return;

  // Clear previous list
  container.innerHTML = '';
  
  if (trackerData.days.length === 0) {
    renderPagination('dashboard-pagination', 1, 0, () => {});
    if (emptyState) emptyState.classList.remove('hidden');
    container.appendChild(emptyState);
    if (daysCount) daysCount.textContent = '0 dias ativos';
    updateGlobalStats();
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  // Sort days by date descending to show the newest days first
  const sortedDays = [...trackerData.days].sort((a, b) => b.date.localeCompare(a.date));

  // Filter days by query (date or notes/observação)
  const query = (filterQuery || '').toLowerCase().trim();
  const filteredDays = sortedDays.filter(day => {
    if (!query) return true;
    const formattedD = formatDate(day.date).toLowerCase();
    const rawD = (day.date || '').toLowerCase();
    const notes = (day.notes || '').toLowerCase();
    return formattedD.includes(query) || rawD.includes(query) || notes.includes(query);
  });

  if (daysCount) {
    const totalCount = trackerData.days.length;
    if (query) {
      daysCount.textContent = `${filteredDays.length} de ${totalCount} dias`;
    } else {
      daysCount.textContent = totalCount === 1 ? '1 dia ativo' : `${totalCount} dias ativos`;
    }
  }

  const freebetCountText = document.getElementById('freebet-count-text');
  if (freebetCountText) {
    const targetDays = query ? filteredDays : trackerData.days;
    let freebetSum = 0;
    targetDays.forEach(day => {
      if (day.bets) {
        day.bets.forEach(b => {
          if (b.freebet) {
            freebetSum += (parseFloat(b.stake) || 0);
          }
        });
      }
    });
    freebetCountText.textContent = `${formatCurrency(freebetSum)} em freebet`;
  }

  if (filteredDays.length === 0) {
    renderPagination('dashboard-pagination', 1, 0, () => {});
    const noResultsMsg = document.createElement('div');
    noResultsMsg.className = 'glass-card rounded-xl p-8 text-center border border-slate-800 text-slate-450';
    noResultsMsg.innerHTML = `
      <div class="p-3 bg-slate-900/80 rounded-xl border border-slate-800 text-slate-500 w-fit mx-auto mb-3">
        <i data-lucide="search-x" class="w-8 h-8"></i>
      </div>
      <p class="text-sm font-medium text-slate-300">Nenhum dia encontrado para "${escapeHTML(query)}"</p>
      <p class="text-xs text-slate-500 mt-1">Tente buscar por outra data (ex: 01/08) ou pela observação do dia.</p>
    `;
    container.appendChild(noResultsMsg);
    if (window.lucide) window.lucide.createIcons();
    updateGlobalStats();
    return;
  }

  // Group filtered days by date string (YYYY-MM-DD)
  const daysByDate = {};
  filteredDays.forEach(day => {
    const dStr = day.date || 'sem-data';
    if (!daysByDate[dStr]) {
      daysByDate[dStr] = [];
    }
    daysByDate[dStr].push(day);
  });

  const sortedDates = Object.keys(daysByDate).sort((a, b) => b.localeCompare(a));
  dashboardPage = clampPage(dashboardPage, sortedDates.length);
  const pagedDateKeys = sortedDates.slice((dashboardPage - 1) * DAYS_PER_PAGE, dashboardPage * DAYS_PER_PAGE);

  pagedDateKeys.forEach((dateKey) => {
    const sessions = daysByDate[dateKey];

    let dateWagered = 0;
    let dateReturn = 0;
    let dateNetProfit = 0;
    let dateBetsCount = 0;

    sessions.forEach(day => {
      (day.bets || []).forEach(bet => {
        dateBetsCount++;
        const stake = bet.stake || 0;
        const odd = bet.odd || 0;
        const isLay = bet.exchangeType === 'lay';
        const liability = (isLay && stake > 0 && odd > 1) ? (stake * (odd - 1)) : 0;
        const riskAmount = isLay ? liability : stake;
        const boostMult = (bet.boostActive && bet.boostPercent > 0) ? (1 + (bet.boostPercent / 100)) : 1;

        if (!bet.freebet) {
          dateWagered += riskAmount;
        }
        dateNetProfit += bet.profit || 0;

        if (bet.status === 'green') {
          if (isLay) {
            dateReturn += bet.freebet ? bet.profit : (liability + bet.profit);
          } else {
            dateReturn += bet.freebet ? bet.profit : (stake + bet.profit);
          }
        } else if (bet.status === 'refunded' && !bet.freebet) {
          dateReturn += riskAmount;
        }
      });
    });

    const dateCard = document.createElement('div');
    dateCard.className = 'dashboard-date-group glass-card rounded-xl border border-slate-800 overflow-hidden shadow-lg transition-all duration-200 animate-slide-down';
    dateCard.setAttribute('data-date-key', dateKey);

    const formattedDate = formatDate(dateKey);
    const profitColor = dateNetProfit > 0 ? 'text-emerald-400' : (dateNetProfit < 0 ? 'text-rose-400' : 'text-slate-300');
    const profitSign = dateNetProfit > 0 ? '+' : '';

    // Auto expand if searching
    const isExpanded = query.length > 0;

    dateCard.innerHTML = `
      <div class="date-group-header flex flex-col md:flex-row md:items-center justify-between gap-3 p-3.5 md:p-4 bg-slate-900/60 hover:bg-slate-850/80 transition-colors cursor-pointer select-none">
        
        <div class="flex items-center justify-between md:justify-start gap-2.5 min-w-0 flex-1">
          <div class="flex items-center gap-2.5 min-w-0">
            <button type="button" class="btn-toggle-date-group p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-200 transition-colors shrink-0">
              <i data-lucide="chevron-right" class="date-chevron-icon w-5 h-5 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}"></i>
            </button>

            <span class="text-sm md:text-base font-bold text-slate-100 flex items-center gap-2 shrink-0">
              <i data-lucide="calendar" class="w-4 h-4 text-blue-400"></i>
              ${formattedDate}
            </span>

            <span class="text-[11px] px-2.5 py-0.5 bg-slate-800/80 border border-slate-700/60 text-slate-300 rounded-full font-medium shrink-0">
              ${sessions.length} ${sessions.length === 1 ? 'aposta' : 'apostas'}
            </span>
          </div>

          <button type="button" class="btn-delete-date-group md:hidden p-1.5 hover:bg-rose-500/15 hover:text-rose-400 text-slate-500 rounded-lg transition-all border border-transparent hover:border-rose-500/30 shrink-0" title="Excluir Todo o Dia ${formattedDate}" data-date-key="${dateKey}">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>

        <div class="flex items-center gap-3 text-xs md:w-[500px] md:min-w-[500px] shrink-0 pt-2 md:pt-0 border-t md:border-t-0 md:border-l border-slate-800/80 md:pl-4 justify-between md:justify-end">
          
          <div class="grid grid-cols-3 md:flex items-center gap-2 md:gap-4 text-xs text-center md:text-left flex-1 md:flex-initial bg-slate-950/80 md:bg-slate-950/50 py-1.5 px-3 rounded-lg border border-slate-800/80">
            <div class="flex flex-col md:flex-row md:items-center gap-1">
              <span class="text-slate-400 text-[10px] md:text-xs uppercase md:normal-case font-medium">Apostado</span>
              <strong class="text-slate-100 font-bold date-total-wagered">${formatCurrency(dateWagered)}</strong>
            </div>

            <div class="flex flex-col md:flex-row md:items-center gap-1 border-x md:border-x-0 border-slate-800 px-2 md:px-0">
              <span class="text-slate-400 text-[10px] md:text-xs uppercase md:normal-case font-medium">Retorno</span>
              <strong class="text-slate-200 font-bold date-total-return">${formatCurrency(dateReturn)}</strong>
            </div>

            <div class="flex flex-col md:flex-row md:items-center gap-1">
              <span class="text-slate-400 text-[10px] md:text-xs uppercase md:normal-case font-medium">Resultado</span>
              <strong class="date-net-profit ${profitColor} font-extrabold">${profitSign}${formatCurrency(dateNetProfit)}</strong>
            </div>
          </div>
          
          <button type="button" class="btn-delete-date-group hidden md:block ml-1 p-1.5 hover:bg-rose-500/15 hover:text-rose-400 text-slate-500 hover:border-rose-500/30 rounded-lg transition-colors border border-transparent shrink-0" title="Excluir Todo o Dia ${formattedDate}" data-date-key="${dateKey}">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>
      </div>

      <div class="date-group-content ${isExpanded ? '' : 'hidden'} p-2 md:p-3 border-t border-slate-800/80 bg-slate-950/40">
        <div class="date-sessions-container space-y-2"></div>
      </div>
    `;

    const sessionsContainer = dateCard.querySelector('.date-sessions-container');
    sessions.forEach(day => {
      const dayHtml = createDayElement(day);
      sessionsContainer.appendChild(dayHtml);
      
      const betsContainer = dayHtml.querySelector('.bets-container');
      
      if (day.bets.length === 0) {
        const emptyBetsMsg = document.createElement('div');
        emptyBetsMsg.className = 'empty-bets-msg p-6 text-center text-xs text-slate-500 bg-slate-950/10';
        emptyBetsMsg.innerHTML = `<i data-lucide="info" class="w-4 h-4 mx-auto mb-1 text-slate-650 inline-block align-middle mr-1.5"></i> Nenhuma aposta cadastrada para esta sessão.`;
        betsContainer.appendChild(emptyBetsMsg);
      } else {
        day.bets.forEach(bet => {
          const betHtml = createBetRowElement(day.id, bet);
          betsContainer.appendChild(betHtml);
          updateBetVisuals(bet, betHtml);
        });
      }
      
      updateDaySummary(day.id, dayHtml);
    });

    // Expand/collapse handler & Delete Date Group handler
    const headerEl = dateCard.querySelector('.date-group-header');
    const contentEl = dateCard.querySelector('.date-group-content');
    const delDateGroupBtns = dateCard.querySelectorAll('.btn-delete-date-group');
    delDateGroupBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        showConfirmDeleteDateGroup(dateKey);
      });
    });

    if (headerEl && contentEl) {
      headerEl.addEventListener('click', (e) => {
        // Prevent toggle if clicking inside an inner button
        if (e.target.closest('button') && !e.target.closest('.btn-toggle-date-group')) {
          return;
        }
        const isHidden = contentEl.classList.contains('hidden');
        const icon = dateCard.querySelector('.date-chevron-icon, .btn-toggle-date-group i, .btn-toggle-date-group svg');
        if (isHidden) {
          contentEl.classList.remove('hidden');
          if (icon) icon.classList.add('rotate-90');
        } else {
          contentEl.classList.add('hidden');
          if (icon) icon.classList.remove('rotate-90');
        }
      });
    }

    container.appendChild(dateCard);
  });

  updateGlobalStats();
  
  // Keep other tabs in sync if currently visible
  const contentHistoryEl = document.getElementById('content-history');
  if (contentHistoryEl && !contentHistoryEl.classList.contains('hidden')) {
    renderHistory();
  }
  const contentBetsSummaryEl = document.getElementById('content-bets-summary');
  if (contentBetsSummaryEl && !contentBetsSummaryEl.classList.contains('hidden')) {
    renderBetsSummary();
  }

  renderPagination('dashboard-pagination', dashboardPage, sortedDates.length, (newPage) => {
    dashboardPage = newPage;
    renderAllDays(filterQuery);
  });

  if (window.lucide) window.lucide.createIcons({ root: container });
}

// Search input listener for Planilha & Dashboard
const inputSearchDays = document.getElementById('input-search-days');
if (inputSearchDays) {
  inputSearchDays.addEventListener('input', (e) => {
    dashboardPage = 1;
    renderAllDays(e.target.value);
  });
}

// ==========================================
// ACTION AND HANDLER OPERATIONS
// ==========================================

// Add a new empty bet row to a specific day
function addBetToDay(dayId) {
  const day = trackerData.days.find(d => d.id === dayId);
  if (!day) return;

  const newBet = {
    id: 'bet-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    bookmaker: '',
    exchangeType: 'back',
    stake: 0,
    odd: 0,
    boostActive: false,
    boostPercent: 0,
    greenPercent: undefined,
    status: 'pending',
    freebet: false,
    profit: 0
  };

  day.bets.push(newBet);
  day.expanded = true;

  saveData();

  const dayElement = document.querySelector(`[data-day-id="${dayId}"]`);
  if (dayElement) {
    const dayContent = dayElement.querySelector('.day-content');
    const betsContainer = dayElement.querySelector('.bets-container');
    const chevronIcon = dayElement.querySelector('.btn-toggle-expand i, .btn-toggle-expand svg');

    // 1. Expand the day visually if it wasn't expanded
    if (dayContent && dayContent.classList.contains('hidden')) {
      dayContent.classList.remove('hidden');
      if (chevronIcon) {
        chevronIcon.classList.add('rotate-90');
      }
    }

    // 2. Remove empty bets message if present
    const emptyMsg = betsContainer.querySelector('.empty-bets-msg');
    if (emptyMsg) {
      emptyMsg.remove();
    }

    // 3. Create and append the new bet row element
    const betHtml = createBetRowElement(dayId, newBet);
    betsContainer.appendChild(betHtml);
    updateBetVisuals(newBet, betHtml);

    // 4. Initialize Lucide icons only for the new row!
    if (window.lucide) {
      window.lucide.createIcons({
        root: betHtml
      });
    }
  } else {
    renderAllDays();
    return;
  }

  // Update summaries
  updateDaySummary(dayId);
  updateGlobalStats();

  // Focus on the first element of the newly created bet row
  setTimeout(() => {
    const newRow = document.querySelector(`[data-bet-id="${newBet.id}"]`);
    if (newRow) {
      const bookmakerInput = newRow.querySelector('[data-field="bookmaker"]');
      if (bookmakerInput) bookmakerInput.focus();
    }
  }, 60);
}

// Expand or collapse a day's bets view
function toggleDayExpand(dayId) {
  const day = trackerData.days.find(d => d.id === dayId);
  if (!day) return;

  day.expanded = !day.expanded;
  saveData();

  const dayElement = document.querySelector(`[data-day-id="${dayId}"]`);
  if (dayElement) {
    const dayContent = dayElement.querySelector('.day-content');
    const chevronIcon = dayElement.querySelector('.btn-toggle-expand i, .btn-toggle-expand svg');
    
    if (day.expanded) {
      dayContent.classList.remove('hidden');
      if (chevronIcon) {
        chevronIcon.classList.add('rotate-90');
      }
    } else {
      dayContent.classList.add('hidden');
      if (chevronIcon) {
        chevronIcon.classList.remove('rotate-90');
      }
    }
  }
}

// Toggle day status (On/Off)
function toggleDayStatus(dayId) {
  const day = trackerData.days.find(d => d.id === dayId);
  if (!day) return;

  day.active = day.active !== false ? false : true;
  saveData();

  const dayElement = document.querySelector(`[data-day-id="${dayId}"]`);
  if (dayElement) {
    const btn = dayElement.querySelector('.btn-toggle-day-status');
    if (btn) {
      const isActive = day.active !== false;
      btn.className = `btn-toggle-day-status flex items-center justify-center p-1.5 rounded-xl border transition-all duration-250 cursor-pointer ${isActive ? 'bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-400 border-emerald-500/25' : 'bg-rose-600/10 hover:bg-rose-600/20 text-rose-400 border-rose-500/25'}`;
      btn.setAttribute('title', `Status: ${isActive ? 'On' : 'Off'}`);
      btn.innerHTML = isActive ? 
        `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5"><rect width="20" height="12" x="2" y="6" rx="6" ry="6"></rect><circle cx="16" cy="12" r="2"></circle></svg>` : 
        `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5"><rect width="20" height="12" x="2" y="6" rx="6" ry="6"></rect><circle cx="8" cy="12" r="2"></circle></svg>`;
    }
  }

  updateGlobalStats();
  renderHistory();
}

// ==========================================
// CUSTOM DIALOG CONFIRMATIONS
// ==========================================

let confirmCallback = null;

function showConfirm(message, onConfirm) {
  const modal = document.getElementById('modal-confirm');
  const msgEl = document.getElementById('confirm-msg');
  if (!modal || !msgEl) return;

  msgEl.innerHTML = message;
  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons({ root: modal });
  confirmCallback = onConfirm;
}

function hideConfirm() {
  const modal = document.getElementById('modal-confirm');
  if (modal) modal.classList.add('hidden');
  confirmCallback = null;
}

document.getElementById('btn-confirm-ok').addEventListener('click', () => {
  if (confirmCallback) confirmCallback();
  hideConfirm();
});

document.getElementById('btn-confirm-cancel').addEventListener('click', hideConfirm);
const btnConfirmX = document.getElementById('btn-confirm-x');
if (btnConfirmX) btnConfirmX.addEventListener('click', hideConfirm);

// Confirmation for deleting an entire day
function showConfirmDeleteDay(dayId) {
  const day = trackerData.days.find(d => d.id === dayId);
  if (!day) return;
  
  const formattedDate = formatDate(day.date);
  const betText = (day.bets || []).length === 1 ? '1 aposta' : `${(day.bets || []).length} apostas`;
  showConfirm(`Tem certeza que deseja excluir a sessão do dia <strong class="text-rose-400 font-bold">${formattedDate}</strong>?<br><br>Todas as <strong class="text-slate-100 font-semibold">${betText}</strong> desta sessão serão removidas permanentemente.`, () => {
    trackerData.days = trackerData.days.filter(d => d.id !== dayId);
    saveData();

    // Remove day element from DOM
    const dayElement = document.querySelector(`[data-day-id="${dayId}"]`);
    if (dayElement) {
      dayElement.remove();
    }

    // Update days active count text
    const daysCount = document.getElementById('days-count');
    if (daysCount) {
      const count = trackerData.days.length;
      daysCount.textContent = count === 0 ? '0 dias ativos' : (count === 1 ? '1 dia ativo' : `${count} dias ativos`);
    }

    // Show empty state if list is empty
    if (trackerData.days.length === 0) {
      const container = document.getElementById('days-container');
      const emptyState = document.getElementById('empty-state');
      if (container && emptyState) {
        emptyState.classList.remove('hidden');
        container.appendChild(emptyState);
      }
    }

    updateGlobalStats();
  });
}

// Confirmation for deleting an ENTIRE date group (all sessions and bets for that calendar date)
function showConfirmDeleteDateGroup(dateKey) {
  const formattedDate = formatDate(dateKey);
  const matchingSessions = trackerData.days.filter(d => (d.date || '') === dateKey);
  let totalBetsCount = 0;
  matchingSessions.forEach(s => {
    totalBetsCount += (s.bets || []).length;
  });

  const sessionText = matchingSessions.length === 1 ? '1 sessão' : `${matchingSessions.length} sessões`;
  const betText = totalBetsCount === 1 ? '1 aposta' : `${totalBetsCount} apostas`;

  showConfirm(`Tem certeza que deseja excluir <strong>TODO o dia <span class="text-rose-400 font-bold">${formattedDate}</span></strong>?<br><br>Esta ação apagará permanentemente todas as <strong class="text-slate-100 font-semibold">${sessionText} (${betText})</strong> deste dia.`, () => {
    trackerData.days = trackerData.days.filter(d => (d.date || '') !== dateKey);
    saveData();
    renderAllDays();
    updateGlobalStats();
  });
}

// Confirmation for deleting a single bet row
function showConfirmDeleteBet(dayId, betId) {
  const day = trackerData.days.find(d => d.id === dayId);
  if (!day) return;
  const bet = day.bets.find(b => b.id === betId);
  if (!bet) return;

  const desc = bet.bookmaker ? `<strong class="text-blue-300 font-semibold">"${escapeHTML(bet.bookmaker)}"</strong>` : 'esta aposta';
  showConfirm(`Tem certeza que deseja excluir a aposta ${desc}?`, () => {
    day.bets = day.bets.filter(b => b.id !== betId);
    saveData();

    // Remove row from DOM
    const betRow = document.querySelector(`[data-bet-id="${betId}"]`);
    if (betRow) {
      const betsContainer = betRow.parentNode;
      betRow.remove();
      
      // If there are no bets left, show empty bets message
      if (day.bets.length === 0 && betsContainer) {
        const emptyBetsMsg = document.createElement('div');
        emptyBetsMsg.className = 'empty-bets-msg p-6 text-center text-xs text-slate-500 bg-slate-950/10';
        emptyBetsMsg.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info w-4 h-4 mx-auto mb-1 text-slate-650 inline-block align-middle mr-1.5"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg> Nenhuma aposta cadastrada para este dia.`;
        betsContainer.appendChild(emptyBetsMsg);
      }
    }

    updateDaySummary(dayId);
    updateGlobalStats();
  });
}

// ==========================================
// MODAL: NEW DAY SESSIONS VIEW HANDLERS
// ==========================================

const modalNewDay = document.getElementById('modal-new-day');
const btnNewDay = document.getElementById('btn-new-day');
const btnNewDayEmpty = document.getElementById('btn-new-day-empty');
const modalClose = document.getElementById('modal-close');
const btnCancelDay = document.getElementById('btn-cancel-day');
const formNewDay = document.getElementById('form-new-day');
const inputDate = document.getElementById('input-date');
const inputNotes = document.getElementById('input-notes');

function openNewDayModal() {
  closeMobileMenu();
  // Set date to today's local date
  const tzoffset = (new Date()).getTimezoneOffset() * 60000; // offset in milliseconds
  const localISOTime = (new Date(Date.now() - tzoffset)).toISOString().slice(0, 10);
  
  inputDate.value = localISOTime;
  inputNotes.value = '';
  modalNewDay.classList.remove('hidden');
  setTimeout(() => inputNotes.focus(), 50);
}

function closeNewDayModal() {
  modalNewDay.classList.add('hidden');
}

btnNewDay.addEventListener('click', openNewDayModal);
if (btnNewDayEmpty) btnNewDayEmpty.addEventListener('click', openNewDayModal);
modalClose.addEventListener('click', closeNewDayModal);
btnCancelDay.addEventListener('click', closeNewDayModal);

formNewDay.addEventListener('submit', (e) => {
  e.preventDefault();
  
  const dateVal = inputDate.value;
  const notesVal = inputNotes.value || '';

  if (!dateVal) return;

  createNewDay(dateVal, notesVal);
});

function createNewDay(date, notes) {
  const newDay = {
    id: 'day-' + Date.now(),
    date: date,
    notes: notes,
    expanded: true,
    active: true,
    bets: []
  };

  trackerData.days.push(newDay);
  dashboardPage = 1;
  saveData();
  closeNewDayModal();
  renderAllDays();
}

function duplicateDay(dayId) {
  const originalDay = trackerData.days.find(d => d.id === dayId);
  if (!originalDay) return;

  const now = Date.now();
  const duplicatedDay = {
    id: 'day-' + now,
    date: originalDay.date,
    notes: originalDay.notes ? `${originalDay.notes}` : '',
    expanded: true,
    active: originalDay.active !== false,
    bets: (originalDay.bets || []).map((bet, idx) => ({
      id: 'bet-' + now + '-' + idx + '-' + Math.floor(Math.random() * 1000),
      bookmaker: bet.bookmaker || '',
      exchangeType: bet.exchangeType || 'back',
      stake: bet.stake || 0,
      odd: bet.odd || 0,
      boostActive: !!bet.boostActive,
      boostPercent: bet.boostPercent || 0,
      greenPercent: bet.greenPercent,
      status: bet.status || 'pending',
      freebet: !!bet.freebet,
      profit: bet.profit || 0
    }))
  };

  const origIndex = trackerData.days.findIndex(d => d.id === dayId);
  if (origIndex !== -1) {
    trackerData.days.splice(origIndex + 1, 0, duplicatedDay);
  } else {
    trackerData.days.push(duplicatedDay);
  }

  saveData();
  renderAllDays();
}

// ==========================================
// MODAL: EDIT DAY SESSIONS VIEW HANDLERS
// ==========================================

const modalEditDay = document.getElementById('modal-edit-day');
const modalEditClose = document.getElementById('modal-edit-close');
const btnCancelEditDay = document.getElementById('btn-cancel-edit-day');
const formEditDay = document.getElementById('form-edit-day');
const inputEditDayId = document.getElementById('input-edit-day-id');
const inputEditDate = document.getElementById('input-edit-date');
const inputEditNotes = document.getElementById('input-edit-notes');

function openEditDayModal(dayId) {
  closeMobileMenu();
  const day = trackerData.days.find(d => d.id === dayId);
  if (!day) return;

  inputEditDayId.value = day.id;
  inputEditDate.value = day.date;
  inputEditNotes.value = day.notes || '';
  
  modalEditDay.classList.remove('hidden');
  setTimeout(() => inputEditNotes.focus(), 50);
}

function closeEditDayModal() {
  modalEditDay.classList.add('hidden');
}

if (modalEditClose) modalEditClose.addEventListener('click', closeEditDayModal);
if (btnCancelEditDay) btnCancelEditDay.addEventListener('click', closeEditDayModal);

if (formEditDay) {
  formEditDay.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const dayId = inputEditDayId.value;
    const dateVal = inputEditDate.value;
    const notesVal = inputEditNotes.value || '';

    if (!dayId || !dateVal) return;

    const day = trackerData.days.find(d => d.id === dayId);
    if (day) {
      day.date = dateVal;
      day.notes = notesVal;
      saveData();
      closeEditDayModal();
      renderAllDays();
    }
  });
}

// ==========================================
// WINDOW & DELEGATION EVENTS INITIALIZATION
// ==========================================

// Global click outside to dismiss modals and mobile menu
window.addEventListener('click', (e) => {
  if (e.target === modalNewDay) {
    closeNewDayModal();
  }
  if (e.target === modalEditDay) {
    closeEditDayModal();
  }
  if (e.target === modalAddBalance) {
    closeAddBalanceModal();
  }
  if (e.target === modalBackupRestore) {
    closeBackupRestoreModal();
  }
  if (e.target === document.getElementById('modal-profile')) {
    closeProfileModal();
  }
  if (e.target === document.getElementById('modal-pnl')) {
    closePnlModal();
  }
  if (e.target === document.getElementById('modal-confirm')) {
    hideConfirm();
  }

  // Dismiss mobile menu when clicking outside header-actions and mobile menu toggle
  const headerActions = document.getElementById('header-actions');
  const btnMobileMenuToggle = document.getElementById('btn-mobile-menu-toggle');
  if (headerActions && !headerActions.classList.contains('hidden')) {
    if (!headerActions.contains(e.target) && !btnMobileMenuToggle?.contains(e.target)) {
      closeMobileMenu();
    }
  }
});

// ESC key listener to exit active modals or mobile menu
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeNewDayModal();
    closeEditDayModal();
    closeAddBalanceModal();
    closeBackupRestoreModal();
    closeProfileModal();
    closePnlModal();
    hideConfirm();
    closeMobileMenu();
  }
});

// Event Delegation for Days Container
const daysContainer = document.getElementById('days-container');

// Click delegation
daysContainer.addEventListener('click', (e) => {
  const btnToggle = e.target.closest('.btn-toggle-expand');
  const btnToggleDayStatus = e.target.closest('.btn-toggle-day-status');
  const btnDuplicateDay = e.target.closest('.btn-duplicate-day');
  const btnAdd = e.target.closest('.btn-add-bet');
  const btnDelDay = e.target.closest('.btn-delete-day');
  const btnEditDay = e.target.closest('.btn-edit-day');
  const btnDelBet = e.target.closest('.btn-delete-bet');
  const btnFreebet = e.target.closest('.btn-freebet');
  const btnBoost = e.target.closest('.btn-boost');
  const btnExchangeType = e.target.closest('.btn-exchange-type');
  const dayHeader = e.target.closest('.day-header');

  // Priority buttons click
  if (btnDelDay) {
    e.stopPropagation();
    const dayId = btnDelDay.closest('[data-day-id]').getAttribute('data-day-id');
    showConfirmDeleteDay(dayId);
    return;
  }

  if (btnDuplicateDay) {
    e.stopPropagation();
    const dayId = btnDuplicateDay.closest('[data-day-id]').getAttribute('data-day-id');
    duplicateDay(dayId);
    return;
  }

  if (btnEditDay) {
    e.stopPropagation();
    const dayId = btnEditDay.closest('[data-day-id]').getAttribute('data-day-id');
    openEditDayModal(dayId);
    return;
  }

  if (btnToggleDayStatus) {
    e.stopPropagation();
    const dayId = btnToggleDayStatus.closest('[data-day-id]').getAttribute('data-day-id');
    toggleDayStatus(dayId);
    return;
  }

  if (btnToggle) {
    e.stopPropagation();
    const dayId = btnToggle.closest('[data-day-id]').getAttribute('data-day-id');
    toggleDayExpand(dayId);
    return;
  }

  if (btnAdd) {
    e.stopPropagation();
    const dayId = btnAdd.closest('[data-day-id]').getAttribute('data-day-id');
    addBetToDay(dayId);
    return;
  }

  if (btnDelBet) {
    e.stopPropagation();
    const betRow = btnDelBet.closest('[data-bet-id]');
    const dayId = betRow.getAttribute('data-day-id');
    const betId = betRow.getAttribute('data-bet-id');
    showConfirmDeleteBet(dayId, betId);
    return;
  }

  if (btnExchangeType) {
    e.stopPropagation();
    const betRow = btnExchangeType.closest('[data-bet-id]');
    const dayId = betRow.getAttribute('data-day-id');
    const betId = betRow.getAttribute('data-bet-id');
    toggleExchangeType(dayId, betId, betRow);
    return;
  }

  if (btnFreebet) {
    e.stopPropagation();
    const betRow = btnFreebet.closest('[data-bet-id]');
    const dayId = betRow.getAttribute('data-day-id');
    const betId = betRow.getAttribute('data-bet-id');
    toggleFreebet(dayId, betId, betRow);
    return;
  }

  if (btnBoost) {
    e.stopPropagation();
    const betRow = btnBoost.closest('[data-bet-id]');
    const dayId = betRow.getAttribute('data-day-id');
    const betId = betRow.getAttribute('data-bet-id');
    toggleBoost(dayId, betId, betRow);
    return;
  }

  // Header click expands or collapses
  if (dayHeader) {
    // If click was directly on inputs/buttons inside header, do nothing
    if (e.target.closest('button') || e.target.closest('input')) return;
    
    const dayId = dayHeader.closest('[data-day-id]').getAttribute('data-day-id');
    toggleDayExpand(dayId);
  }
});

// Toggle Exchange type (Back / Lay)
function toggleExchangeType(dayId, betId, rowElement) {
  const day = trackerData.days.find(d => d.id === dayId);
  if (!day) return;
  const bet = day.bets.find(b => b.id === betId);
  if (!bet) return;

  bet.exchangeType = (bet.exchangeType === 'lay') ? 'back' : 'lay';

  const exchangeBtn = rowElement.querySelector('[data-field="exchangeType"]');
  if (exchangeBtn) {
    exchangeBtn.setAttribute('data-exchange-type', bet.exchangeType);
  }

  updateBetCalculations(dayId, betId, rowElement);
}

// Toggle Freebet status and trigger calculations
function toggleFreebet(dayId, betId, rowElement) {
  const day = trackerData.days.find(d => d.id === dayId);
  if (!day) return;
  const bet = day.bets.find(b => b.id === betId);
  if (!bet) return;

  bet.freebet = !bet.freebet;

  // Toggle visual active attribute instantly before calculation reads it
  const freebetBtn = rowElement.querySelector('[data-field="freebet"]');
  if (freebetBtn) {
    freebetBtn.setAttribute('data-active', bet.freebet ? 'true' : 'false');
  }

  updateBetCalculations(dayId, betId, rowElement);
}

// Toggle % Aumentada boost status and trigger calculations
function toggleBoost(dayId, betId, rowElement) {
  const day = trackerData.days.find(d => d.id === dayId);
  if (!day) return;
  const bet = day.bets.find(b => b.id === betId);
  if (!bet) return;

  bet.boostActive = !bet.boostActive;

  const boostBtn = rowElement.querySelector('[data-field="boostActive"]');
  const boostInput = rowElement.querySelector('[data-field="boostPercent"]');
  if (boostBtn) {
    boostBtn.setAttribute('data-active', bet.boostActive ? 'true' : 'false');
  }
  if (boostInput) {
    boostInput.disabled = !bet.boostActive;
    if (bet.boostActive) {
      setTimeout(() => boostInput.focus(), 50);
    }
  }

  updateBetCalculations(dayId, betId, rowElement);
}

// Key typing / value input delegation
daysContainer.addEventListener('input', (e) => {
  const inputEl = e.target;
  const field = inputEl.getAttribute('data-field');
  if (!field) return;

  const betRow = inputEl.closest('[data-bet-id]');
  if (!betRow) return;

  const dayId = betRow.getAttribute('data-day-id');
  const betId = betRow.getAttribute('data-bet-id');

  updateBetCalculations(dayId, betId, betRow, true);
});

// Selector drop-down delegation
daysContainer.addEventListener('change', (e) => {
  const selectEl = e.target;
  const field = selectEl.getAttribute('data-field');
  if (field !== 'status') return;

  const betRow = selectEl.closest('[data-bet-id]');
  if (!betRow) return;

  const dayId = betRow.getAttribute('data-day-id');
  const betId = betRow.getAttribute('data-bet-id');

  updateBetCalculations(dayId, betId, betRow);
});

// ==========================================
// BANCO CENTRAL (GESTÃO POR DIA) LOGIC
// ==========================================

function calculateBankState() {
  const configuredBank = parseFloat(trackerData.bankInitialBalance || 0);
  const bankInitialDate = trackerData.bankInitialDate || null;
  // Aportes e retiradas feitos no modal também fazem parte do saldo do Banco.
  const manualTransactionsTotal = getBalanceHistory().reduce((total, transaction) => {
    return total + (parseFloat(transaction.amount || 0) || 0);
  }, 0);
  const hasBankBalance = configuredBank !== 0 || manualTransactionsTotal !== 0;

  // Group ALL days by date string (YYYY-MM-DD)
  const daysByDate = {};
  (trackerData.days || []).forEach(day => {
    const dStr = day.date || 'sem-data';
    if (!daysByDate[dStr]) daysByDate[dStr] = [];
    daysByDate[dStr].push(day);
  });

  let totalBankImpact = 0;
  let totalDaysWagered = 0;
  let totalDaysReturn = 0;
  const daySummaries = [];

  const sortedDatesAsc = Object.keys(daysByDate).sort((a, b) => a.localeCompare(b));

  sortedDatesAsc.forEach(dateKey => {
    const sessions = daysByDate[dateKey];
    let dateWagered = 0;
    let dateReturn = 0;
    let dateNetProfit = 0;
    let dateBetsCount = 0;
    const dateBets = [];
    const sessionSummaries = [];

    const isDayActive = sessions.some(d => d.active !== false);

    let pendingWagered = 0;
    let pendingCount = 0;
    let resolvedCount = 0;

    sessions.forEach((day, sessionIndex) => {
      let sessionWagered = 0;
      let sessionReturn = 0;
      let sessionProfit = 0;
      (day.bets || []).forEach(bet => {
        dateBetsCount++;
        dateBets.push({
          ...bet,
          dayNotes: day.notes
        });
        const stake = parseFloat(bet.stake || 0);
        const odd = parseFloat(bet.odd || 0);
        const isLay = bet.exchangeType === 'lay';
        const liability = (isLay && stake > 0 && odd > 1) ? (stake * (odd - 1)) : 0;
        const riskAmount = isLay ? liability : stake;
        const betProfit = parseFloat(bet.profit || 0);
        const isPending = (bet.status === 'pending' || !bet.status);

        if (!bet.freebet) {
          dateWagered += riskAmount;
          sessionWagered += riskAmount;
        }

        if (isPending) {
          pendingCount++;
          if (!bet.freebet) {
            pendingWagered += riskAmount;
          }
        } else {
          resolvedCount++;
          if (bet.status === 'green') {
            if (isLay) {
              dateReturn += bet.freebet ? betProfit : (liability + betProfit);
              sessionReturn += bet.freebet ? betProfit : (liability + betProfit);
            } else {
              dateReturn += bet.freebet ? betProfit : (stake + betProfit);
              sessionReturn += bet.freebet ? betProfit : (stake + betProfit);
            }
          } else if (bet.status === 'refunded' && !bet.freebet) {
            dateReturn += riskAmount;
            sessionReturn += riskAmount;
          }
        }

        dateNetProfit += betProfit;
        sessionProfit += betProfit;
      });

      sessionSummaries.push({
        id: day.id,
        dateKey: dateKey,
        title: day.notes && day.notes.trim() ? day.notes.trim() : `Aposta #${sessionIndex + 1}`,
        wagered: sessionWagered,
        returned: sessionReturn,
        profit: sessionProfit
      });
    });

    if (sessions.length > 0) {
      totalDaysWagered += dateWagered;
      totalDaysReturn += dateReturn;

      // IMPACTO NO BANCO:
      // 1. Se Toggle OFF (isDayActive === false) e < bankInitialDate: 0 (já incluso no Saldo Base do Banco)
      // 2. Se Toggle OFF (isDayActive === false) e >= bankInitialDate: soma o lucro líquido (+dateNetProfit)
      // 3. Se Toggle ON (isDayActive === true): cada aposta resolvida contribui com seu lucro/prejuízo (+betProfit),
      //    e cada aposta em andamento desconta apenas a sua própria stake/responsabilidade (-riskAmount se não for freebet).
      let bankImpact = 0;
      if (bankInitialDate && dateKey < bankInitialDate && !isDayActive) {
        bankImpact = 0;
      } else if (!isDayActive) {
        bankImpact = dateNetProfit;
      } else {
        let totalImpact = 0;
        sessions.forEach(day => {
          (day.bets || []).forEach(bet => {
            const stake = parseFloat(bet.stake || 0);
            const odd = parseFloat(bet.odd || 0);
            const isLay = bet.exchangeType === 'lay';
            const liability = (isLay && stake > 0 && odd > 1) ? (stake * (odd - 1)) : 0;
            const riskAmount = isLay ? liability : stake;
            const betProfit = parseFloat(bet.profit || 0);
            const isPending = (bet.status === 'pending' || !bet.status);

            if (isPending) {
              if (!bet.freebet) {
                totalImpact -= riskAmount;
              }
            } else {
              totalImpact += betProfit;
            }
          });
        });
        bankImpact = totalImpact;
      }

      if (hasBankBalance) {
        totalBankImpact += bankImpact;
      }

      daySummaries.push({
        dateKey,
        dateWagered,
        dateReturn,
        dateNetProfit,
        bankImpact,
        pendingWagered,
        pendingCount,
        resolvedCount,
        hasPendingBets: pendingCount > 0,
        betsCount: sessions.length,
        isDayActive,
        bets: dateBets,
        sessions: sessionSummaries
      });
    }
  });

  const currentBankBalance = configuredBank + manualTransactionsTotal + totalBankImpact;

  return {
    manualInitialBalance: configuredBank,
    manualTransactionsTotal,
    totalBankImpact,
    totalDaysWagered,
    totalDaysReturn,
    currentBankBalance,
    daySummaries
  };
}

// Recompute global capital (Banca Atualizada no cabeçalho = Resultado acumulado das apostas)
function updateGlobalCapital() {
  const totalDisplay = document.getElementById('display-global-total');
  if (!totalDisplay) return;

  let netProfit = 0;
  (trackerData.days || []).forEach(day => {
    (day.bets || []).forEach(bet => {
      netProfit += parseFloat(bet.profit || 0);
    });
  });

  totalDisplay.textContent = (netProfit > 0 ? '+' : '') + formatCurrency(netProfit);

  if (netProfit > 0) {
    totalDisplay.className = 'text-xs font-bold mt-0.5 text-emerald-400';
  } else if (netProfit < 0) {
    totalDisplay.className = 'text-xs font-bold mt-0.5 text-rose-400';
  } else {
    totalDisplay.className = 'text-xs font-bold mt-0.5 text-slate-300';
  }
}

// Bank Initial Balance Edit Handlers
const btnEditBankInitial = document.getElementById('btn-edit-bank-initial');
const btnSaveBankInitial = document.getElementById('btn-save-bank-initial');
const bankInitialDisplayWrap = document.getElementById('bank-initial-display-wrap');
const bankInitialInputWrap = document.getElementById('bank-initial-input-wrap');
const inputBankInitialVal = document.getElementById('input-bank-initial-val');

if (btnEditBankInitial) {
  btnEditBankInitial.addEventListener('click', () => {
    const curVal = trackerData.bankInitialBalance !== undefined ? trackerData.bankInitialBalance : 0;
    if (inputBankInitialVal) inputBankInitialVal.value = curVal ? curVal.toString() : '';
    if (bankInitialDisplayWrap) bankInitialDisplayWrap.classList.add('hidden');
    if (bankInitialInputWrap) bankInitialInputWrap.classList.remove('hidden');
    setTimeout(() => {
      if (inputBankInitialVal) inputBankInitialVal.focus();
    }, 50);
  });
}

function saveBankInitialValue() {
  if (!inputBankInitialVal) return;
  const newVal = parseFloat(inputBankInitialVal.value) || 0;
  trackerData.bankInitialBalance = newVal;
  if (newVal > 0) {
    const activeDays = (trackerData.days || []).filter(d => d.active !== false && d.date);
    let targetDate = null;
    if (activeDays.length > 0) {
      targetDate = activeDays.reduce((min, d) => (d.date < min ? d.date : min), activeDays[0].date);
    } else {
      const now = new Date();
      targetDate = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0');
    }
    trackerData.bankInitialDate = targetDate;
  } else {
    trackerData.bankInitialDate = null;
  }
  saveData();
  if (bankInitialDisplayWrap) bankInitialDisplayWrap.classList.remove('hidden');
  if (bankInitialInputWrap) bankInitialInputWrap.classList.add('hidden');
  renderHistory();
}

if (btnSaveBankInitial) btnSaveBankInitial.addEventListener('click', saveBankInitialValue);
if (inputBankInitialVal) {
  inputBankInitialVal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBankInitialValue();
    }
  });
}

// MODAL: ADICIONAR SALDO VIEW HANDLERS
const modalAddBalance = document.getElementById('modal-add-balance');
const btnAddBalanceModal = document.getElementById('btn-add-balance-modal');
const modalAddBalanceClose = document.getElementById('modal-add-balance-close');
const btnCancelAddBalance = document.getElementById('btn-cancel-add-balance');
const formAddBalance = document.getElementById('form-add-balance');

const btnBalanceModeDirect = document.getElementById('btn-balance-mode-direct');
const btnBalanceModeCalc = document.getElementById('btn-balance-mode-calc');
const sectionBalanceDirect = document.getElementById('section-balance-direct');
const sectionBalanceCalc = document.getElementById('section-balance-calc');

const inputAddBalanceVal = document.getElementById('input-add-balance-val');
const inputCalcWagered = document.getElementById('input-calc-wagered');
const inputCalcReturned = document.getElementById('input-calc-returned');
const inputAddBalanceDesc = document.getElementById('input-add-balance-desc');

const calcPreviewVal = document.getElementById('calc-preview-val');
const calcPreviewSub = document.getElementById('calc-preview-sub');

let currentBalanceMode = 'direct'; // 'direct' or 'calc'

function setBalanceMode(mode) {
  currentBalanceMode = mode;
  const activeBtnClass = "flex-1 py-1.5 px-3 text-xs font-semibold rounded-lg bg-blue-600 text-white transition-colors flex items-center justify-center gap-1.5 shadow-sm";
  const inactiveBtnClass = "flex-1 py-1.5 px-3 text-xs font-semibold rounded-lg text-slate-400 hover:text-slate-200 transition-colors flex items-center justify-center gap-1.5";

  if (mode === 'calc') {
    if (btnBalanceModeCalc) btnBalanceModeCalc.className = activeBtnClass;
    if (btnBalanceModeDirect) btnBalanceModeDirect.className = inactiveBtnClass;
    if (sectionBalanceCalc) sectionBalanceCalc.classList.remove('hidden');
    if (sectionBalanceDirect) sectionBalanceDirect.classList.add('hidden');
    if (inputCalcWagered) inputCalcWagered.focus();
  } else {
    if (btnBalanceModeDirect) btnBalanceModeDirect.className = activeBtnClass;
    if (btnBalanceModeCalc) btnBalanceModeCalc.className = inactiveBtnClass;
    if (sectionBalanceDirect) sectionBalanceDirect.classList.remove('hidden');
    if (sectionBalanceCalc) sectionBalanceCalc.classList.add('hidden');
    if (inputAddBalanceVal) inputAddBalanceVal.focus();
  }
  updateCalcPreview();
}

function updateCalcPreview() {
  if (!calcPreviewVal || !calcPreviewSub) return;
  const wagered = parseFloat(inputCalcWagered ? inputCalcWagered.value : 0) || 0;
  const returned = parseFloat(inputCalcReturned ? inputCalcReturned.value : 0) || 0;
  const result = returned - wagered;

  if (wagered === 0 && returned === 0) {
    calcPreviewVal.textContent = 'R$ 0,00';
    calcPreviewVal.className = 'text-base font-bold text-slate-300';
    calcPreviewSub.textContent = 'Informe quanto apostou e quanto voltou.';
    return;
  }

  if (result > 0) {
    calcPreviewVal.textContent = `+${formatCurrency(result)}`;
    calcPreviewVal.className = 'text-base font-bold text-emerald-400';
    calcPreviewSub.textContent = `Lucro líquido de +${formatCurrency(result)} (Apostou: ${formatCurrency(wagered)} | Retornou: ${formatCurrency(returned)})`;
  } else if (result < 0) {
    calcPreviewVal.textContent = formatCurrency(result);
    calcPreviewVal.className = 'text-base font-bold text-rose-400';
    calcPreviewSub.textContent = `Prejuízo de ${formatCurrency(result)} (Apostou: ${formatCurrency(wagered)} | Retornou: ${formatCurrency(returned)})`;
  } else {
    calcPreviewVal.textContent = 'R$ 0,00';
    calcPreviewVal.className = 'text-base font-bold text-slate-300';
    calcPreviewSub.textContent = 'Retorno igual ao valor apostado (Empate / Devolvido).';
  }
}

if (btnBalanceModeDirect) btnBalanceModeDirect.addEventListener('click', () => setBalanceMode('direct'));
if (btnBalanceModeCalc) btnBalanceModeCalc.addEventListener('click', () => setBalanceMode('calc'));

if (inputCalcWagered) inputCalcWagered.addEventListener('input', updateCalcPreview);
if (inputCalcReturned) inputCalcReturned.addEventListener('input', updateCalcPreview);

function openAddBalanceModal() {
  closeMobileMenu();
  if (!modalAddBalance) return;
  if (inputAddBalanceVal) inputAddBalanceVal.value = '';
  if (inputCalcWagered) inputCalcWagered.value = '';
  if (inputCalcReturned) inputCalcReturned.value = '';
  if (inputAddBalanceDesc) inputAddBalanceDesc.value = '';
  setBalanceMode('direct');
  modalAddBalance.classList.remove('hidden');
}

function closeAddBalanceModal() {
  if (modalAddBalance) modalAddBalance.classList.add('hidden');
}

if (btnAddBalanceModal) btnAddBalanceModal.addEventListener('click', openAddBalanceModal);
const btnBankDeposit = document.getElementById('btn-bank-deposit');
if (btnBankDeposit) btnBankDeposit.addEventListener('click', openAddBalanceModal);

if (modalAddBalanceClose) modalAddBalanceClose.addEventListener('click', closeAddBalanceModal);
if (btnCancelAddBalance) btnCancelAddBalance.addEventListener('click', closeAddBalanceModal);

if (formAddBalance) {
  formAddBalance.addEventListener('submit', (e) => {
    e.preventDefault();
    let val = 0;
    let description = (inputAddBalanceDesc ? inputAddBalanceDesc.value : '').trim();

    if (currentBalanceMode === 'calc') {
      const wagered = parseFloat(inputCalcWagered ? inputCalcWagered.value : 0) || 0;
      const returned = parseFloat(inputCalcReturned ? inputCalcReturned.value : 0) || 0;
      val = returned - wagered;
      if (!description) {
        description = `Operação: Apostou ${formatCurrency(wagered)} / Retornou ${formatCurrency(returned)}`;
      }
    } else {
      val = parseFloat(inputAddBalanceVal ? inputAddBalanceVal.value : 0) || 0;
      if (!description) {
        description = val >= 0 ? 'Depósito Inicial / Aporte no Banco' : 'Retirada de Saldo do Banco';
      }
    }
    
    if (val !== 0) {
      // Accumulate onto global balance
      globalBalance += val;
      
      // Save transaction to history list
      const history = getBalanceHistory();
      const newTx = {
        id: 'tx-' + Date.now(),
        timestamp: new Date().toISOString(),
        amount: val,
        description: description
      };
      history.push(newTx);
      saveBalanceHistory(history);
      
      updateGlobalCapital();
      renderHistory();
      if (typeof updateDashboardStats === 'function') updateDashboardStats();
    }
    closeAddBalanceModal();
  });
}

// ==========================================
// BALANCE HISTORY HELPERS & HANDLERS
// ==========================================

function getBalanceHistory() {
  return balanceHistory || [];
}

function saveBalanceHistory(history) {
  balanceHistory = history || [];
  saveData();
}

function formatDateTime(isoString) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '-';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const weekday = weekdays[date.getDay()];
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  
  return `${day}/${month} (${weekday}) <span class="text-xs text-slate-500 font-normal ml-1">às ${hours}:${minutes}</span>`;
}

let expandedHistoryDates = new Set();
let historyExpandedInitialized = false;

function goToBet(dayId, dateKey) {
  activateDashboardTab();

  const searchInput = document.getElementById('input-search-days');
  if (searchInput && searchInput.value) {
    searchInput.value = '';
    renderAllDays('');
  }

  if (dayId) {
    const day = (trackerData.days || []).find(d => d.id === dayId);
    if (day) {
      day.expanded = true;
      const orderedDates = [...new Set((trackerData.days || []).map(item => item.date).filter(Boolean))].sort((a, b) => b.localeCompare(a));
      const dateIndex = orderedDates.indexOf(day.date);
      if (dateIndex >= 0) dashboardPage = Math.floor(dateIndex / DAYS_PER_PAGE) + 1;
      renderAllDays(searchInput ? searchInput.value : '');
    }
  }

  setTimeout(() => {
    let targetEl = null;

    if (dayId) {
      targetEl = document.querySelector(`[data-day-id="${dayId}"]`);
    }

    if (!targetEl && dateKey) {
      targetEl = document.querySelector(`[data-date-key="${dateKey}"]`);
    }

    if (targetEl) {
      const dateGroup = targetEl.closest('.dashboard-date-group');
      if (dateGroup) {
        const contentDiv = dateGroup.querySelector('.date-group-content');
        const chevron = dateGroup.querySelector('.date-chevron-icon, .btn-toggle-date-group i, .btn-toggle-date-group svg');
        if (contentDiv && contentDiv.classList.contains('hidden')) {
          contentDiv.classList.remove('hidden');
          if (chevron) chevron.classList.add('rotate-90');
        }
      }

      const dayContent = targetEl.querySelector('.day-content');
      if (dayContent && dayContent.classList.contains('hidden')) {
        dayContent.classList.remove('hidden');
        const chevron = targetEl.querySelector('.btn-toggle-expand i, .btn-toggle-expand svg');
        if (chevron) chevron.classList.add('rotate-90');
      }

      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

      targetEl.classList.add('ring-2', 'ring-blue-500', 'ring-offset-2', 'ring-offset-slate-950', 'transition-all', 'duration-500');
      setTimeout(() => {
        targetEl.classList.remove('ring-2', 'ring-blue-500', 'ring-offset-2', 'ring-offset-slate-950');
      }, 3000);
    }
  }, 120);
}

function renderHistorySessionsHtml(sessions, displayDate, itemWageredText, itemReturnText) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (list.length === 0) return '';

  const rows = list.map((session, index) => {
    const profit = parseFloat(session.profit || 0);
    const profitClass = profit > 0 ? 'text-emerald-400' : (profit < 0 ? 'text-rose-400' : 'text-slate-400');
    const dayIdAttr = session.id ? `data-day-id="${session.id}"` : '';
    const dateKeyAttr = session.dateKey ? `data-date-key="${session.dateKey}"` : '';

    return `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/60 hover:border-slate-700/80 transition-colors text-xs">
        <span class="font-semibold text-slate-200 truncate">${session.title || `Aposta #${index + 1}`}</span>
        <div class="flex items-center gap-2.5 text-[11px] shrink-0">
          <button type="button" class="btn-go-to-bet flex items-center gap-1 text-[11px] font-semibold text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 px-2 py-1 rounded-md border border-blue-500/30 transition-all shrink-0 cursor-pointer" ${dayIdAttr} ${dateKeyAttr} title="Ir para esta aposta na Planilha">
            <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
            <span>Ver aposta</span>
          </button>
          <span class="text-slate-400">Apostado: <strong class="text-slate-200">${formatCurrency(session.wagered || 0)}</strong></span>
          <span class="text-slate-400">Retorno: <strong class="text-emerald-400">${formatCurrency(session.returned || 0)}</strong></span>
          <span class="font-bold min-w-[70px] text-right ${profitClass}">${profit > 0 ? '+' : ''}${formatCurrency(profit)}</span>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="bg-slate-900/70 rounded-xl p-3.5 border border-slate-800/80 space-y-2.5">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-xs font-bold text-slate-300 border-b border-slate-800/80 pb-2">
        <span class="flex items-center gap-1.5 text-blue-400"><i data-lucide="list" class="w-4 h-4"></i>Apostas do Dia em ${displayDate} (${list.length} ${list.length === 1 ? 'aposta' : 'apostas'}):</span>
        <span class="text-[11px] text-slate-400 font-normal">Apostado: <strong class="text-slate-200">${itemWageredText}</strong> | Retorno: <strong class="text-emerald-400">${itemReturnText}</strong></span>
      </div>
      <div class="space-y-1.5">${rows}</div>
    </div>`;
}

function renderHistoryBetsHtml(betsList, displayDate, itemWageredText, itemReturnText, itemDateReturn, itemDateWagered, sessionsCount = betsList.length) {
  if (!Array.isArray(betsList) || betsList.length === 0) {
    return `
      <div class="bg-slate-900/70 rounded-xl p-3 border border-slate-800/80">
        <div class="text-xs text-slate-500 py-1 text-center italic">Nenhuma aposta registrada nesta sessão diária.</div>
      </div>
    `;
  }

  const itemsHtml = betsList.map((bet, idx) => {
    if (!bet) return '';
    try {
      const stake = parseFloat(bet.stake || 0);
      const odd = parseFloat(bet.odd || 0);
      const profit = parseFloat(bet.profit || 0);
      const isLay = bet.exchangeType === 'lay';
      const liability = (isLay && stake > 0 && odd > 1) ? (stake * (odd - 1)) : 0;
      const riskAmount = isLay ? liability : stake;

      let statusBadge = '';
      const st = String(bet.status || '').toLowerCase();
      if (st === 'green') {
        statusBadge = '<span class="px-2 py-0.5 rounded-lg text-[10px] font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Green</span>';
      } else if (st === 'red') {
        statusBadge = '<span class="px-2 py-0.5 rounded-lg text-[10px] font-bold bg-rose-950/80 text-rose-400 border border-rose-500/30 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span> Red</span>';
      } else if (st === 'refunded') {
        statusBadge = '<span class="px-2 py-0.5 rounded-lg text-[10px] font-bold bg-amber-950/80 text-amber-400 border border-amber-500/30 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span> Reembolso</span>';
      } else {
        statusBadge = '<span class="px-2 py-0.5 rounded-lg text-[10px] font-bold bg-slate-900 text-slate-400 border border-slate-700 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span> Em andamento</span>';
      }

      let profitBadgeClass = 'text-slate-400 font-semibold';
      let profitSign = '';
      if (profit > 0) {
        profitBadgeClass = 'text-emerald-400 font-bold';
        profitSign = '+';
      } else if (profit < 0) {
        profitBadgeClass = 'text-rose-400 font-bold';
      }

      const desc = bet.description && String(bet.description).trim() ? String(bet.description).trim() : `Aposta #${idx + 1}`;
      const boostVal = parseFloat(bet.boostPercent || 0);

      return `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 rounded-xl bg-slate-950/70 border border-slate-800/70 hover:border-slate-700 transition-colors text-sm">
          <div class="flex items-center gap-2 min-w-0">
            <span class="px-2 py-0.5 rounded-md text-xs font-bold ${isLay ? 'bg-purple-950/80 text-purple-300 border border-purple-800/50' : 'bg-blue-950/80 text-blue-300 border border-blue-800/50'} uppercase shrink-0">
              ${isLay ? 'Lay' : 'Back'}
            </span>
            <span class="font-semibold text-slate-200 truncate text-sm">${escapeHTML(desc)}</span>
            ${bet.freebet ? '<span class="px-2 py-0.5 rounded-md text-xs font-bold bg-amber-950/80 text-amber-300 border border-amber-800/50 shrink-0">FREEBET</span>' : ''}
            ${bet.boostActive && boostVal > 0 ? `<span class="px-2 py-0.5 rounded-md text-xs font-bold bg-blue-950/80 text-blue-300 border border-blue-800/50 shrink-0">+${boostVal}%</span>` : ''}
          </div>

          <div class="flex items-center gap-3.5 shrink-0 self-end sm:self-auto">
            <span class="text-slate-400 text-xs">Odd: <strong class="text-slate-200 font-bold">${odd > 0 ? odd.toFixed(2) : '-'}</strong></span>
            <span class="text-slate-400 text-xs">Apostado: <strong class="text-slate-200 font-bold">${formatCurrency(riskAmount)}</strong></span>
            <div class="mx-0.5">${statusBadge}</div>
            <span class="text-sm font-bold min-w-[85px] text-right tabular-nums ${profitBadgeClass}">${profitSign}${formatCurrency(profit)}</span>
          </div>
        </div>
      `;
    } catch (err) {
      console.error('Error rendering bet item:', err);
      return '';
    }
  }).join('');

  return `
    <div class="bg-slate-900/80 rounded-xl p-4 border border-slate-800/80 space-y-3">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-sm font-bold text-slate-300 border-b border-slate-800/80 pb-2.5">
        <span class="flex items-center gap-2 text-blue-400">
          <i data-lucide="list" class="w-4 h-4"></i>
          Apostas do Dia em ${displayDate} (${sessionsCount} ${sessionsCount === 1 ? 'aposta' : 'apostas'}):
        </span>
        <span class="text-xs text-slate-400 font-normal">
          Apostado: <strong class="text-slate-200">${itemWageredText}</strong> | Retorno: <strong class="${(itemDateReturn > itemDateWagered) ? 'text-emerald-400 font-bold' : (itemDateReturn === 0 ? 'text-slate-300 font-medium' : 'text-slate-200 font-medium')}">${itemReturnText}</strong>
        </span>
      </div>
      <div class="space-y-2">${itemsHtml}</div>
    </div>
  `;
}

function formatDayMonth(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length < 3) return dateStr;
  return `${parts[2]}/${parts[1]}`;
}

let bankFilterType = 'total'; // 'total', 'week', 'month', 'custom'

function renderHistory() {
  try {
    const bankState = calculateBankState();
    const { manualInitialBalance, totalDaysWagered, totalDaysReturn, currentBankBalance, daySummaries } = bankState;

    if (!historyExpandedInitialized) {
      expandedHistoryDates.clear();
      historyExpandedInitialized = true;
    }

    let totalRealProfit = 0;
    (trackerData.days || []).forEach(day => {
      (day.bets || []).forEach(bet => {
        totalRealProfit += parseFloat(bet.profit || 0);
      });
    });

    const bankDateStartInput = document.getElementById('bank-date-start');
    const bankDateEndInput = document.getElementById('bank-date-end');

    const bankStartVal = bankDateStartInput ? bankDateStartInput.value : '';
    const bankEndVal = bankDateEndInput ? bankDateEndInput.value : '';
    const isFiltered = Boolean(bankStartVal || bankEndVal);

    // Métricas na Data / Período no Banco (Se nenhum filtro ativo, calcula o total acumulado)
    let dateProfit = 0;
    let dateDeposits = 0;
    let dateWagered = 0;
    let dateReturn = 0;

    (trackerData.days || []).forEach(day => {
      const dStr = day.date || '';
      if (!dStr) return;
      if (bankStartVal && dStr < bankStartVal) return;
      if (bankEndVal && dStr > bankEndVal) return;

      (day.bets || []).forEach(bet => {
        const stake = parseFloat(bet.stake || 0);
        const odd = parseFloat(bet.odd || 0);
        const isLay = bet.exchangeType === 'lay';
        const liability = (isLay && stake > 0 && odd > 1) ? (stake * (odd - 1)) : 0;
        const riskAmount = isLay ? liability : stake;
        const betProfit = parseFloat(bet.profit || 0);

        if (!bet.freebet) {
          dateWagered += riskAmount;
        }

        if (bet.status === 'green') {
          if (isLay) {
            dateReturn += bet.freebet ? betProfit : (liability + betProfit);
          } else {
            dateReturn += bet.freebet ? betProfit : (stake + betProfit);
          }
        } else if (bet.status === 'refunded' && !bet.freebet) {
          dateReturn += riskAmount;
        }

        dateProfit += betProfit;
      });
    });

    const historyList = getBalanceHistory();
    historyList.forEach(tx => {
      const txDate = tx.timestamp ? tx.timestamp.slice(0, 10) : '';
      if (!txDate) return;
      if (bankStartVal && txDate < bankStartVal) return;
      if (bankEndVal && txDate > bankEndVal) return;

      const amt = parseFloat(tx.amount || 0);
      if (amt > 0) {
        dateDeposits += amt;
      }
    });

    // Atualiza Tag Dinâmica do Período nos Cards: (total), (mês), (semana) ou (DD/MM-DD/MM)
    let periodTagText = '(total)';
    if (bankFilterType === 'week') {
      periodTagText = '(semana)';
    } else if (bankFilterType === 'month') {
      periodTagText = '(mês)';
    } else if (bankStartVal || bankEndVal) {
      if (bankStartVal && bankEndVal) {
        periodTagText = `(${formatDayMonth(bankStartVal)}-${formatDayMonth(bankEndVal)})`;
      } else if (bankStartVal) {
        periodTagText = `(desde ${formatDayMonth(bankStartVal)})`;
      } else {
        periodTagText = `(até ${formatDayMonth(bankEndVal)})`;
      }
    } else {
      periodTagText = '(total)';
    }

    const bankCardPeriodTag = document.getElementById('bank-card-period-tag');
    const bankCardDepositsTag = document.getElementById('bank-card-deposits-tag');
    const bankCardVolumeTag = document.getElementById('bank-card-volume-tag');

    if (bankCardPeriodTag) bankCardPeriodTag.textContent = periodTagText;
    if (bankCardDepositsTag) bankCardDepositsTag.textContent = periodTagText;
    if (bankCardVolumeTag) bankCardVolumeTag.textContent = periodTagText;

    // Atualiza Card: Saldo do Banco
    const bankStatCurrentBalance = document.getElementById('bank-stat-current-balance');
    if (bankStatCurrentBalance) bankStatCurrentBalance.textContent = formatCurrency(currentBankBalance);

    // Atualiza Card: Ganho / Lucro do Período
    const bankStatMonthProfit = document.getElementById('bank-stat-month-profit');
    const bankStatMonthProfitSub = document.getElementById('bank-stat-month-profit-sub');
    const bankMonthProfitIconBg = document.getElementById('bank-month-profit-icon-bg');

    if (bankStatMonthProfit) {
      bankStatMonthProfit.textContent = (dateProfit >= 0 ? '+' : '') + formatCurrency(dateProfit);
      if (dateProfit > 0) {
        bankStatMonthProfit.className = 'text-2xl sm:text-3xl font-extrabold tracking-tight tabular-nums text-emerald-400';
        if (bankMonthProfitIconBg) bankMonthProfitIconBg.className = 'p-2 bg-emerald-950/80 rounded-lg text-emerald-400 shrink-0';
      } else if (dateProfit < 0) {
        bankStatMonthProfit.className = 'text-2xl sm:text-3xl font-extrabold tracking-tight tabular-nums text-rose-400';
        if (bankMonthProfitIconBg) bankMonthProfitIconBg.className = 'p-2 bg-rose-950/80 rounded-lg text-rose-400 shrink-0';
      } else {
        bankStatMonthProfit.className = 'text-2xl sm:text-3xl font-extrabold tracking-tight tabular-nums text-blue-400';
        if (bankMonthProfitIconBg) bankMonthProfitIconBg.className = 'p-2 bg-blue-900/60 rounded-lg text-blue-400 shrink-0';
      }
    }

    if (bankStatMonthProfitSub) {
      bankStatMonthProfitSub.textContent = isFiltered ? 'Lucro de apostas no período' : 'Lucro acumulado nas apostas';
    }

    // Atualiza Card: Aportes no Período
    const bankStatMonthDeposits = document.getElementById('bank-stat-month-deposits');
    const bankStatMonthDepositsSub = document.getElementById('bank-stat-month-deposits-sub');
    if (bankStatMonthDeposits) {
      bankStatMonthDeposits.textContent = formatCurrency(dateDeposits);
    }
    if (bankStatMonthDepositsSub) {
      bankStatMonthDepositsSub.textContent = isFiltered ? 'Saldos adicionados no período' : 'Saldos adicionados no total';
    }

    // Atualiza Card: Resultado Geral dos Dias
    const bankStatDaysProfit = document.getElementById('bank-stat-days-profit');
    const bankDaysProfitIconBg = document.getElementById('bank-days-profit-icon-bg');

    if (bankStatDaysProfit) {
      bankStatDaysProfit.textContent = (totalRealProfit >= 0 ? '+' : '') + formatCurrency(totalRealProfit);
      if (totalRealProfit > 0) {
        bankStatDaysProfit.className = 'text-2xl sm:text-3xl font-extrabold tracking-tight tabular-nums text-emerald-400';
        if (bankDaysProfitIconBg) bankDaysProfitIconBg.className = 'p-2 bg-emerald-950/80 rounded-lg text-emerald-400 shrink-0';
      } else if (totalRealProfit < 0) {
        bankStatDaysProfit.className = 'text-2xl sm:text-3xl font-extrabold tracking-tight tabular-nums text-rose-400';
        if (bankDaysProfitIconBg) bankDaysProfitIconBg.className = 'p-2 bg-rose-950/80 rounded-lg text-rose-400 shrink-0';
      } else {
        bankStatDaysProfit.className = 'text-2xl sm:text-3xl font-extrabold tracking-tight tabular-nums text-slate-100';
        if (bankDaysProfitIconBg) bankDaysProfitIconBg.className = 'p-2 bg-slate-900/60 rounded-lg text-blue-400 shrink-0';
      }
    }

    // Atualiza Card: Volume e Retorno no Período
    const bankStatVolume = document.getElementById('bank-stat-volume');
    const bankStatReturnSub = document.getElementById('bank-stat-return-sub');

    if (bankStatVolume) bankStatVolume.textContent = formatCurrency(dateWagered);
    if (bankStatReturnSub) {
      bankStatReturnSub.textContent = `Retorno: ${formatCurrency(dateReturn)}`;
      bankStatReturnSub.className = dateReturn >= dateWagered ? 'text-xs text-emerald-400 mt-1.5 font-semibold' : 'text-xs text-rose-400 mt-1.5 font-semibold';
    }

    const tbody = document.getElementById('history-table-body');
    const emptyState = document.getElementById('history-empty-state');
    if (!tbody) return;

    tbody.innerHTML = '';

    const ledgerItems = [];

    historyList.forEach(tx => {
      const amountVal = parseFloat(tx.amount || 0);
      const isPositive = amountVal >= 0;
      const descText = (tx.description && tx.description.trim())
        ? tx.description.trim()
        : (isPositive ? 'Depósito / Aporte no Banco' : 'Retirada do Banco');

      const iconDot = isPositive
        ? '<span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-emerald-500/20 shrink-0"></span>'
        : '<span class="inline-block w-2.5 h-2.5 rounded-full bg-rose-400 ring-2 ring-rose-500/20 shrink-0"></span>';

      const txIcon = isPositive ? 'arrow-down-left' : 'arrow-up-right';
      const txColor = isPositive ? 'text-emerald-400' : 'text-rose-400';

      ledgerItems.push({
        id: tx.id,
        timestamp: tx.timestamp || new Date().toISOString(),
        category: 'manual',
        typeLabel: `
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 flex items-center justify-center shrink-0">
              ${iconDot}
            </div>
            <span class="flex items-center gap-2 font-semibold text-sm ${txColor}">
              <i data-lucide="${txIcon}" class="w-4 h-4 shrink-0"></i>
              <span class="truncate text-sm text-slate-200 font-medium">${escapeHTML(descText)}</span>
              <span class="text-[11px] px-1.5 py-0.5 rounded font-semibold ${isPositive ? 'bg-emerald-950/60 border border-emerald-500/20 text-emerald-400' : 'bg-rose-950/60 border border-rose-500/20 text-rose-400'}">${isPositive ? 'Aporte' : 'Retirada'}</span>
            </span>
          </div>
        `,
        wageredText: '<span class="inline-block text-slate-600 font-semibold select-none pr-3">—</span>',
        returnText: '<span class="inline-block text-slate-600 font-semibold select-none pr-3">—</span>',
        resultText: isPositive ? `+${formatCurrency(amountVal)}` : formatCurrency(amountVal),
        amountClass: isPositive ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold',
        isDeletable: true,
        amount: amountVal
      });
    });

    daySummaries.forEach(day => {
      let resultText = '';
      let amountClass = '';

      const hasPending = day.hasPendingBets && day.isDayActive;

      if (day.bankImpact > 0) {
        resultText = `+${formatCurrency(day.bankImpact)}`;
        amountClass = 'text-emerald-400 font-bold';
      } else if (day.bankImpact < 0) {
        resultText = formatCurrency(day.bankImpact);
        amountClass = hasPending ? 'text-amber-400 font-bold' : 'text-rose-400 font-bold';
      } else {
        resultText = formatCurrency(0);
        amountClass = 'text-slate-400 font-bold';
      }

      const isExpanded = expandedHistoryDates.has(day.dateKey);

      let statusBadgeHtml = '';
      if (hasPending) {
        if (day.pendingCount && day.pendingCount < day.betsCount) {
          statusBadgeHtml = `<span class="text-xs px-2 py-0.5 rounded-md bg-amber-950/80 border border-amber-500/30 text-amber-300 font-semibold">${day.pendingCount} de ${day.betsCount} EM ANDAMENTO</span>`;
        } else {
          statusBadgeHtml = `<span class="text-xs px-2 py-0.5 rounded-md bg-emerald-950/80 border border-emerald-500/30 text-emerald-300 font-semibold">EM ANDAMENTO</span>`;
        }
      }

      let returnText = '';
      if (hasPending && day.resolvedCount === 0) {
        returnText = 'Em andamento';
      } else if (hasPending && day.resolvedCount > 0) {
        returnText = `${formatCurrency(day.dateReturn)} <span class="text-xs text-amber-400 font-semibold">(parcial)</span>`;
      } else {
        returnText = formatCurrency(day.dateReturn);
      }

      ledgerItems.push({
        id: 'day-' + day.dateKey,
        timestamp: day.dateKey + 'T23:59:59.000Z',
        category: 'day',
        typeLabel: `
          <div class="flex items-center gap-2">
            <button type="button" class="btn-toggle-history-day text-slate-400 hover:text-blue-400 transition-colors p-1 rounded-md hover:bg-slate-800 shrink-0" data-date="${day.dateKey}">
              <i data-lucide="chevron-right" class="w-4 h-4 transition-transform duration-200 ${isExpanded ? 'rotate-90 text-blue-400' : ''}"></i>
            </button>
            <span class="flex items-center gap-2 font-semibold text-sm ${day.isDayActive ? 'text-emerald-400' : 'text-blue-400'}">
              <i data-lucide="calendar" class="w-4 h-4 shrink-0"></i>
              <span>Sessão Diária (${day.betsCount} ${day.betsCount === 1 ? 'aposta' : 'apostas'})</span>
              ${statusBadgeHtml}
            </span>
          </div>
        `,
        wageredText: formatCurrency(day.dateWagered),
        returnText: returnText,
        resultText: resultText,
        amountClass: amountClass,
        isDeletable: false,
        amount: day.bankImpact,
        formattedDate: formatDate(day.dateKey),
        dateKey: day.dateKey,
        bets: day.bets || [],
        sessions: day.sessions || [],
        dateWagered: day.dateWagered,
        dateReturn: day.dateReturn,
        isDayActive: day.isDayActive
      });
    });

    ledgerItems.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const sortedAsc = [...ledgerItems].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let runningBal = manualInitialBalance;
    const runningBalances = {};
    sortedAsc.forEach(item => {
      runningBal += item.amount;
      runningBalances[item.id] = runningBal;
    });

    // Aplica filtro por data de início/fim se informado
    let visibleItems = ledgerItems;
    if (bankStartVal || bankEndVal) {
      visibleItems = ledgerItems.filter(item => {
        const itemDate = item.dateKey || (item.timestamp ? item.timestamp.slice(0, 10) : '');
        if (bankStartVal && itemDate < bankStartVal) return false;
        if (bankEndVal && itemDate > bankEndVal) return false;
        return true;
      });
    }

    if (visibleItems.length === 0) {
      renderPagination('history-pagination', 1, 0, () => {});
      if (emptyState) emptyState.classList.remove('hidden');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    // Keep every movement from the same calendar date together, then paginate
    // by ten dates so the bank statement stays coherent.
    const visibleDateKeys = [...new Set(visibleItems.map(item => item.dateKey || (item.timestamp ? item.timestamp.slice(0, 10) : '')).filter(Boolean))];
    historyPage = clampPage(historyPage, visibleDateKeys.length);
    const pagedHistoryDates = new Set(visibleDateKeys.slice((historyPage - 1) * DAYS_PER_PAGE, historyPage * DAYS_PER_PAGE));
    const pagedItems = visibleItems.filter(item => pagedHistoryDates.has(item.dateKey || (item.timestamp ? item.timestamp.slice(0, 10) : '')));

    pagedItems.forEach(item => {
      const tr = document.createElement('tr');
      const isDayItem = item.category === 'day';
      const isExpanded = isDayItem && expandedHistoryDates.has(item.dateKey);

      tr.className = `hover:bg-slate-800/30 transition-colors border-b border-slate-800/60 ${isDayItem ? 'cursor-pointer group' : ''}`;
      if (isDayItem) tr.dataset.dateKey = item.dateKey;

      const displayDate = item.formattedDate || formatDateTime(item.timestamp);
      const endBal = runningBalances[item.id] !== undefined ? formatCurrency(runningBalances[item.id]) : '-';

      tr.innerHTML = `
        <td class="py-4 pl-3 text-sm text-slate-300 font-medium whitespace-nowrap">${displayDate}</td>
        <td class="py-4 px-3 text-sm">${item.typeLabel}</td>
        <td class="py-4 px-3 text-right text-sm text-slate-400 font-medium tabular-nums">${item.wageredText}</td>
        <td class="py-4 px-3 text-right text-sm text-slate-400 font-medium tabular-nums">${item.returnText}</td>
        <td class="py-4 px-3 text-right text-sm font-bold tabular-nums ${item.amountClass}">${item.resultText}</td>
        <td class="py-4 px-3 text-right text-sm font-bold text-slate-100 tabular-nums">${endBal}</td>
        <td class="py-4 px-3 text-center w-24">
          <div class="flex items-center justify-center">
            ${item.isDeletable ? `
              <button class="btn-delete-tx text-slate-400 hover:text-rose-400 p-1.5 hover:bg-slate-800 rounded-lg transition-colors inline-flex items-center justify-center" data-tx-id="${escapeHTML(item.id)}" title="Desfazer Lançamento Manual">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" x2="10" y1="11" y2="17"></line><line x1="14" x2="14" y1="11" y2="17"></line></svg>
              </button>
            ` : `<span class="inline-flex items-center justify-center px-2.5 py-1 rounded-md text-xs font-semibold text-slate-400 bg-slate-800/60 border border-slate-700/60">Sessão</span>`}
          </div>
        </td>
      `;

      tbody.appendChild(tr);

      if (isDayItem) {
        const subTr = document.createElement('tr');
        subTr.id = `history-subrow-${item.dateKey}`;
        subTr.className = `${isExpanded ? '' : 'hidden'} bg-slate-950/80 border-b border-slate-900/60`;

        const sessionList = item.sessions || [];
        subTr.innerHTML = `
          <td colspan="7" class="py-3 px-3 sm:px-6">
            ${renderHistorySessionsHtml(sessionList, displayDate, item.wageredText, item.returnText)}
          </td>
        `;

        tbody.appendChild(subTr);
      }
    });

    tbody.onclick = (e) => {
      const btnGoTo = e.target.closest('.btn-go-to-bet');
      if (btnGoTo) {
        e.stopPropagation();
        const dayId = btnGoTo.dataset.dayId;
        const dateKey = btnGoTo.dataset.dateKey;
        goToBet(dayId, dateKey);
        return;
      }

      if (e.target.closest('.btn-delete-tx')) return;
      const mainRow = e.target.closest('tr[data-date-key]');
      if (!mainRow) return;

      const dKey = mainRow.dataset.dateKey;
      if (!dKey) return;

      if (expandedHistoryDates.has(dKey)) {
        expandedHistoryDates.delete(dKey);
      } else {
        expandedHistoryDates.add(dKey);
      }

      renderHistory();
    };

    renderPagination('history-pagination', historyPage, visibleDateKeys.length, (newPage) => {
      historyPage = newPage;
      renderHistory();
    });

    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    console.error('Erro em renderHistory:', err);
  }
}

// BANCO CENTRAL DATE FILTER LISTENERS
const bankDateStartInput = document.getElementById('bank-date-start');
const bankDateEndInput = document.getElementById('bank-date-end');
const btnBankThisWeek = document.getElementById('btn-bank-this-week');
const btnBankThisMonth = document.getElementById('btn-bank-this-month');
const btnBankClearDates = document.getElementById('btn-bank-clear-dates');

function setBankDateRange(start, end, filterType = 'custom') {
  bankFilterType = filterType;
  historyPage = 1;
  if (bankDateStartInput) bankDateStartInput.value = start || '';
  if (bankDateEndInput) bankDateEndInput.value = end || '';
  if (!start && !end) bankFilterType = 'total';
  renderHistory();
}

if (btnBankThisWeek) {
  btnBankThisWeek.addEventListener('click', () => {
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    setBankDateRange(formatLocalDateInput(monday), formatLocalDateInput(today), 'week');
  });
}

if (btnBankThisMonth) {
  btnBankThisMonth.addEventListener('click', () => {
    const today = new Date();
    setBankDateRange(formatLocalDateInput(new Date(today.getFullYear(), today.getMonth(), 1)), formatLocalDateInput(today), 'month');
  });
}

if (btnBankClearDates) {
  btnBankClearDates.addEventListener('click', () => setBankDateRange('', '', 'total'));
}

if (bankDateStartInput) bankDateStartInput.addEventListener('change', () => {
  bankFilterType = 'custom';
  historyPage = 1;
  renderHistory();
});
if (bankDateEndInput) bankDateEndInput.addEventListener('change', () => {
  bankFilterType = 'custom';
  historyPage = 1;
  renderHistory();
});

let summaryFilterType = 'total'; // 'total', 'week', 'month', 'custom'
let expandedSummaryDates = new Set();

const summaryDateStartInput = document.getElementById('summary-date-start');
const summaryDateEndInput = document.getElementById('summary-date-end');
const btnSummaryThisWeek = document.getElementById('btn-summary-this-week');
const btnSummaryThisMonth = document.getElementById('btn-summary-this-month');
const btnSummaryClearDates = document.getElementById('btn-summary-clear-dates');

function formatLocalDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function setSummaryDateRange(start, end, filterType = 'custom') {
  summaryFilterType = filterType;
  summaryPage = 1;
  if (summaryDateStartInput) summaryDateStartInput.value = start || '';
  if (summaryDateEndInput) summaryDateEndInput.value = end || '';
  if (!start && !end) summaryFilterType = 'total';
  expandedSummaryDates.clear();
  renderBetsSummary();
}

if (summaryDateStartInput) summaryDateStartInput.addEventListener('change', () => {
  summaryFilterType = 'custom';
  summaryPage = 1;
  renderBetsSummary();
});
if (summaryDateEndInput) summaryDateEndInput.addEventListener('change', () => {
  summaryFilterType = 'custom';
  summaryPage = 1;
  renderBetsSummary();
});
if (btnSummaryClearDates) btnSummaryClearDates.addEventListener('click', () => setSummaryDateRange('', '', 'total'));
if (btnSummaryThisWeek) btnSummaryThisWeek.addEventListener('click', () => {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  setSummaryDateRange(formatLocalDateInput(monday), formatLocalDateInput(today), 'week');
});
if (btnSummaryThisMonth) btnSummaryThisMonth.addEventListener('click', () => {
  const today = new Date();
  setSummaryDateRange(formatLocalDateInput(new Date(today.getFullYear(), today.getMonth(), 1)), formatLocalDateInput(today), 'month');
});

function renderBetsSummary() {
  const tbody = document.getElementById('bets-summary-table-body');
  const tfoot = document.getElementById('bets-summary-table-foot');
  const emptyState = document.getElementById('bets-summary-empty-state');
  
  const summaryTotalStakedEl = document.getElementById('summary-stat-total-staked');
  const summaryTotalWonEl = document.getElementById('summary-stat-total-won');
  const summaryTotalLostEl = document.getElementById('summary-stat-total-lost');
  const summaryNetProfitEl = document.getElementById('summary-stat-net-profit');
  const summaryNetProfitCard = document.getElementById('summary-card-net-profit');
  const summaryNetProfitIconContainer = document.getElementById('summary-icon-container-net-profit');
  const summaryDaysCountEl = document.getElementById('summary-days-count');

  const startDate = summaryDateStartInput ? summaryDateStartInput.value : '';
  const endDate = summaryDateEndInput ? summaryDateEndInput.value : '';

  // Dynamic period tag text on Resumo de Apostas cards (equal to Banco Central)
  let periodTagText = '(total)';
  if (summaryFilterType === 'week') {
    periodTagText = '(semana)';
  } else if (summaryFilterType === 'month') {
    periodTagText = '(mês)';
  } else if (startDate || endDate) {
    if (startDate && endDate) {
      periodTagText = `(${formatDayMonth(startDate)}-${formatDayMonth(endDate)})`;
    } else if (startDate) {
      periodTagText = `(desde ${formatDayMonth(startDate)})`;
    } else {
      periodTagText = `(até ${formatDayMonth(endDate)})`;
    }
  } else {
    periodTagText = '(total)';
  }

  const summaryCardStakedTag = document.getElementById('summary-card-staked-tag');
  const summaryCardWonTag = document.getElementById('summary-card-won-tag');
  const summaryCardPeriodTag = document.getElementById('summary-card-period-tag');

  if (summaryCardStakedTag) summaryCardStakedTag.textContent = periodTagText;
  if (summaryCardWonTag) summaryCardWonTag.textContent = periodTagText;
  if (summaryCardPeriodTag) summaryCardPeriodTag.textContent = periodTagText;

  if (!tbody) return;

  tbody.innerHTML = '';
  if (tfoot) tfoot.innerHTML = '';

  let grandTotalStaked = 0;
  let grandTotalReturn = 0;
  let grandTotalLost = 0;
  let grandNetProfit = 0;
  let grandTotalBets = 0;

  const daysInRange = (trackerData.days || []).filter(day => {
    const date = day.date || '';
    return (!startDate || date >= startDate) && (!endDate || date <= endDate);
  });

  if (daysInRange.length === 0) {
    renderPagination('summary-pagination', 1, 0, () => {});
    if (emptyState) emptyState.classList.remove('hidden');
    if (summaryTotalStakedEl) summaryTotalStakedEl.textContent = formatCurrency(0);
    if (summaryTotalWonEl) summaryTotalWonEl.textContent = formatCurrency(0);
    if (summaryTotalLostEl) summaryTotalLostEl.textContent = formatCurrency(0);
    if (summaryNetProfitEl) {
      summaryNetProfitEl.textContent = formatCurrency(0);
      summaryNetProfitEl.className = 'text-2xl font-bold tracking-tight text-slate-100';
    }
    if (summaryDaysCountEl) summaryDaysCountEl.textContent = '0 dias';
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  // Group all sessions by calendar date (YYYY-MM-DD)
  const dateMap = {};

  daysInRange.forEach(day => {
    const dKey = day.date;
    if (!dateMap[dKey]) {
      dateMap[dKey] = {
        date: dKey,
        notes: [],
        sessions: [],
        bets: []
      };
    }
    if (day.notes && day.notes.trim()) {
      dateMap[dKey].notes.push(day.notes.trim());
    }
    dateMap[dKey].sessions.push(day);
    if (day.bets && day.bets.length > 0) {
      dateMap[dKey].bets.push(...day.bets);
    }
  });

  const sortedDateKeys = Object.keys(dateMap).sort((a, b) => b.localeCompare(a));
  summaryPage = clampPage(summaryPage, sortedDateKeys.length);
  const pagedDateKeys = new Set(sortedDateKeys.slice((summaryPage - 1) * DAYS_PER_PAGE, summaryPage * DAYS_PER_PAGE));

  if (summaryDaysCountEl) {
    const totalUniqueDays = sortedDateKeys.length;
    summaryDaysCountEl.textContent = `${totalUniqueDays} ${totalUniqueDays === 1 ? 'dia' : 'dias'}`;
  }

  sortedDateKeys.forEach(dateKey => {
    const group = dateMap[dateKey];
    let totalStaked = 0;
    let totalReturn = 0;
    let totalLost = 0;
    let netProfit = 0;

    (group.bets || []).forEach(bet => {
      const stakeVal = parseFloat(bet.stake) || 0;
      const oddVal = parseFloat(bet.odd) || 0;
      const isLay = bet.exchangeType === 'lay';
      const liability = (isLay && stakeVal > 0 && oddVal > 1) ? (stakeVal * (oddVal - 1)) : 0;
      const riskVal = isLay ? liability : stakeVal;
      const boostMult = (bet.boostActive && bet.boostPercent > 0) ? (1 + (parseFloat(bet.boostPercent) / 100)) : 1;
      
      if (!bet.freebet) {
        totalStaked += riskVal;
      }
      
      if (bet.status === 'green') {
        if (isLay) {
          if (bet.freebet) {
            totalReturn += bet.profit || (stakeVal * boostMult);
          } else {
            totalReturn += liability + (bet.profit || (stakeVal * boostMult));
          }
        } else {
          if (bet.freebet) {
            totalReturn += ((stakeVal * oddVal) - stakeVal) * boostMult;
          } else {
            totalReturn += ((stakeVal * oddVal) - stakeVal) * boostMult + stakeVal;
          }
        }
      } else if (bet.status === 'red') {
        if (!bet.freebet) {
          totalLost += riskVal;
        }
      } else if (bet.status === 'refunded') {
        if (!bet.freebet) {
          totalReturn += riskVal;
        }
      }
      
      netProfit += bet.profit || 0;
    });

    const dayBetsTotal = (group.bets || []).length;

    grandTotalStaked += totalStaked;
    grandTotalReturn += totalReturn;
    grandTotalLost += totalLost;
    grandNetProfit += netProfit;
    grandTotalBets += dayBetsTotal;

    if (!pagedDateKeys.has(dateKey)) return;

    const formattedDate = formatDate(dateKey);
    const notesJoined = Array.from(new Set(group.notes)).join(' • ') || '-';
    
    // Net profit style badge
    const netClass = netProfit > 0 
      ? 'text-emerald-400 font-bold bg-emerald-500/10 px-3 py-1.5 rounded-xl border border-emerald-500/20 inline-block shadow-sm shadow-emerald-500/5' 
      : (netProfit < 0 
        ? 'text-rose-400 font-bold bg-rose-500/10 px-3 py-1.5 rounded-xl border border-rose-500/20 inline-block shadow-sm shadow-rose-500/5' 
        : 'text-slate-300 font-semibold bg-slate-800/50 px-3 py-1.5 rounded-xl border border-slate-700/40 inline-block');
    
    const returnColorClass = totalReturn >= totalStaked ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold';
    const isExpanded = expandedSummaryDates.has(dateKey);

    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-900/60 transition-colors border-b border-slate-900/40 cursor-pointer group';
    tr.dataset.dateKey = dateKey;

    tr.innerHTML = `
      <td class="py-4 pl-3 text-xs font-bold text-slate-100 flex items-center gap-2">
        <button type="button" class="btn-toggle-summary-day text-slate-400 group-hover:text-blue-400 transition-transform duration-200 p-0.5 rounded hover:bg-slate-800" data-date="${dateKey}">
          <i data-lucide="chevron-right" class="w-4 h-4 transition-transform duration-200 ${isExpanded ? 'rotate-90 text-blue-400' : ''}"></i>
        </button>
        <i data-lucide="calendar" class="w-4 h-4 text-blue-400"></i>
        <span>${formattedDate}</span>
      </td>
      <td class="py-4 text-xs text-slate-400 truncate max-w-[240px]" title="${escapeHTML(notesJoined)}">${escapeHTML(notesJoined)}</td>
      <td class="py-4 text-right text-xs font-semibold text-slate-200">${formatCurrency(totalStaked)}</td>
      <td class="py-4 text-right text-xs ${returnColorClass}">${formatCurrency(totalReturn)}</td>
      <td class="py-4 text-right pr-3 text-xs">
        <span class="${netClass}">${netProfit > 0 ? '+' : ''}${formatCurrency(netProfit)}</span>
      </td>
    `;
    
    tbody.appendChild(tr);

    // Sub-row showing each session breakdown for this date
    const subTr = document.createElement('tr');
    subTr.id = `summary-subrow-${dateKey}`;
    subTr.className = `${isExpanded ? '' : 'hidden'} bg-slate-950/80 border-b border-slate-900/60`;

    let sessionsHTML = '';
    group.sessions.forEach((sess, idx) => {
      let sessStaked = 0;
      let sessReturn = 0;
      let sessProfit = 0;

      (sess.bets || []).forEach(b => {
        const stakeVal = parseFloat(b.stake) || 0;
        const oddVal = parseFloat(b.odd) || 0;
        const isLay = b.exchangeType === 'lay';
        const liability = (isLay && stakeVal > 0 && oddVal > 1) ? (stakeVal * (oddVal - 1)) : 0;
        const riskVal = isLay ? liability : stakeVal;
        const boostMult = (b.boostActive && b.boostPercent > 0) ? (1 + (parseFloat(b.boostPercent) / 100)) : 1;

        if (!b.freebet) sessStaked += riskVal;
        if (b.status === 'green') {
          if (isLay) {
            sessReturn += b.freebet ? (b.profit || (stakeVal * boostMult)) : (liability + (b.profit || (stakeVal * boostMult)));
          } else {
            sessReturn += b.freebet ? (b.profit || (((stakeVal * oddVal) - stakeVal) * boostMult)) : (stakeVal + (b.profit || (((stakeVal * oddVal) - stakeVal) * boostMult)));
          }
        } else if (b.status === 'refunded' && !b.freebet) {
          sessReturn += riskVal;
        }
        sessProfit += b.profit || 0;
      });

      const sessNetClass = sessProfit > 0 
        ? 'text-emerald-400 font-bold' 
        : (sessProfit < 0 ? 'text-rose-400 font-bold' : 'text-slate-300 font-semibold');

      const sessReturnClass = sessReturn >= sessStaked ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold';
      const sessTitle = sess.notes && sess.notes.trim() ? sess.notes.trim() : `Sessão #${idx + 1}`;

      sessionsHTML += `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3 bg-slate-900/70 rounded-xl border border-slate-800/80 hover:border-slate-700 transition-colors">
          <div class="flex items-center gap-2">
            <i data-lucide="tag" class="w-3.5 h-3.5 text-blue-400"></i>
            <span class="text-xs font-bold text-slate-200">${escapeHTML(sessTitle)}</span>
          </div>
          <div class="flex flex-wrap items-center gap-4 text-xs">
            <span class="text-slate-400">Apostado: <strong class="text-slate-200">${formatCurrency(sessStaked)}</strong></span>
            <span class="text-slate-400">Retorno: <strong class="${sessReturnClass}">${formatCurrency(sessReturn)}</strong></span>
            <span class="text-slate-400">Resultado: <strong class="${sessNetClass}">${sessProfit > 0 ? '+' : ''}${formatCurrency(sessProfit)}</strong></span>
          </div>
        </div>
      `;
    });

    subTr.innerHTML = `
      <td colspan="5" class="py-3 px-4 sm:px-6">
        <div class="space-y-2">
          <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <i data-lucide="layers" class="w-3.5 h-3.5 text-blue-400"></i>
            Sessões Registradas em ${formattedDate} (${group.sessions.length}):
          </div>
          <div class="space-y-2">
            ${sessionsHTML}
          </div>
        </div>
      </td>
    `;

    tbody.appendChild(subTr);
  });

  // Attach click delegate to tbody for expand/collapse
  tbody.onclick = (e) => {
    const mainRow = e.target.closest('tr[data-date-key]');
    if (!mainRow) return;

    const dKey = mainRow.dataset.dateKey;
    if (!dKey) return;

    if (expandedSummaryDates.has(dKey)) {
      expandedSummaryDates.delete(dKey);
    } else {
      expandedSummaryDates.add(dKey);
    }

    renderBetsSummary();
  };

  // Render Table Footer (Totais Acumulados)
  if (tfoot) {
    const footNetClass = grandNetProfit > 0 
      ? 'text-emerald-400 font-bold bg-emerald-500/15 px-3 py-1.5 rounded-xl border border-emerald-500/30 inline-block' 
      : (grandNetProfit < 0 
        ? 'text-rose-400 font-bold bg-rose-500/15 px-3 py-1.5 rounded-xl border border-rose-500/30 inline-block' 
        : 'text-slate-200 font-bold bg-slate-800/60 px-3 py-1.5 rounded-xl border border-slate-700/40 inline-block');

    const footReturnColorClass = grandTotalReturn >= grandTotalStaked ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold';

    tfoot.innerHTML = `
      <tr class="bg-slate-900/70">
        <td colspan="2" class="py-4 pl-3 text-xs font-bold text-slate-100 uppercase tracking-wider">Total Geral (${sortedDateKeys.length} ${sortedDateKeys.length === 1 ? 'dia' : 'dias'})</td>
        <td class="py-4 text-right text-xs font-bold text-slate-100">${formatCurrency(grandTotalStaked)}</td>
        <td class="py-4 text-right text-xs ${footReturnColorClass}">${formatCurrency(grandTotalReturn)}</td>
        <td class="py-4 text-right pr-3 text-xs">
          <span class="${footNetClass}">${grandNetProfit > 0 ? '+' : ''}${formatCurrency(grandNetProfit)}</span>
        </td>
      </tr>
    `;
  }

  // Update Top Stat Cards for Global Totals
  if (summaryTotalStakedEl) summaryTotalStakedEl.textContent = formatCurrency(grandTotalStaked);
  if (summaryTotalWonEl) {
    summaryTotalWonEl.textContent = formatCurrency(grandTotalReturn);
    summaryTotalWonEl.className = `text-2xl font-bold tracking-tight ${grandTotalReturn >= grandTotalStaked ? 'text-emerald-400' : 'text-rose-400'}`;
  }
  if (summaryTotalLostEl) summaryTotalLostEl.textContent = formatCurrency(grandTotalLost);
  
  if (summaryNetProfitEl) {
    summaryNetProfitEl.textContent = (grandNetProfit > 0 ? '+' : '') + formatCurrency(grandNetProfit);
    if (grandNetProfit > 0) {
      summaryNetProfitEl.className = 'text-2xl font-bold tracking-tight text-emerald-400';
      if (summaryNetProfitCard) {
        summaryNetProfitCard.className = 'glass-card rounded-xl p-5 border border-slate-800 flex flex-col justify-between transition-all duration-300 glow-green';
      }
      if (summaryNetProfitIconContainer) {
        summaryNetProfitIconContainer.className = 'p-2 bg-emerald-500/10 rounded-lg text-emerald-400';
      }
    } else if (grandNetProfit < 0) {
      summaryNetProfitEl.className = 'text-2xl font-bold tracking-tight text-rose-400';
      if (summaryNetProfitCard) {
        summaryNetProfitCard.className = 'glass-card rounded-xl p-5 border border-slate-800 flex flex-col justify-between transition-all duration-300 glow-red';
      }
      if (summaryNetProfitIconContainer) {
        summaryNetProfitIconContainer.className = 'p-2 bg-slate-900/60 rounded-lg text-rose-400';
      }
    } else {
      summaryNetProfitEl.className = 'text-2xl font-bold tracking-tight text-slate-100';
      if (summaryNetProfitCard) {
        summaryNetProfitCard.className = 'glass-card rounded-xl p-5 border border-slate-800 flex flex-col justify-between transition-all duration-300 glow-neutral';
      }
      if (summaryNetProfitIconContainer) {
        summaryNetProfitIconContainer.className = 'p-2 bg-slate-900/60 rounded-lg text-blue-400';
      }
    }
  }

  renderPagination('summary-pagination', summaryPage, sortedDateKeys.length, (newPage) => {
    summaryPage = newPage;
    renderBetsSummary();
  });

  if (window.lucide) {
    window.lucide.createIcons({ root: tbody });
  }
}

// Function to consolidate data for Bet Summary Reports
function getBetsSummaryData() {
  if (!trackerData || !trackerData.days || trackerData.days.length === 0) {
    return { dateGroups: [], grandTotalStaked: 0, grandTotalReturn: 0, grandTotalLost: 0, grandNetProfit: 0, grandTotalBets: 0 };
  }

  const dateMap = {};

  trackerData.days.forEach(day => {
    const dKey = day.date;
    if (!dateMap[dKey]) {
      dateMap[dKey] = {
        date: dKey,
        notes: [],
        sessions: [],
        bets: []
      };
    }
    if (day.notes && day.notes.trim()) {
      dateMap[dKey].notes.push(day.notes.trim());
    }
    dateMap[dKey].sessions.push(day);
    if (day.bets && day.bets.length > 0) {
      dateMap[dKey].bets.push(...day.bets);
    }
  });

  const sortedDateKeys = Object.keys(dateMap).sort((a, b) => b.localeCompare(a));

  let grandTotalStaked = 0;
  let grandTotalReturn = 0;
  let grandTotalLost = 0;
  let grandNetProfit = 0;
  let grandTotalBets = 0;

  const dateGroups = sortedDateKeys.map(dateKey => {
    const group = dateMap[dateKey];
    let totalStaked = 0;
    let totalReturn = 0;
    let totalLost = 0;
    let netProfit = 0;

    (group.bets || []).forEach(bet => {
      const stakeVal = parseFloat(bet.stake) || 0;
      const oddVal = parseFloat(bet.odd) || 0;
      const isLay = bet.exchangeType === 'lay';
      const liability = (isLay && stakeVal > 0 && oddVal > 1) ? (stakeVal * (oddVal - 1)) : 0;
      const riskVal = isLay ? liability : stakeVal;
      const boostMult = (bet.boostActive && bet.boostPercent > 0) ? (1 + (parseFloat(bet.boostPercent) / 100)) : 1;
      
      if (!bet.freebet) {
        totalStaked += riskVal;
      }
      
      if (bet.status === 'green') {
        if (isLay) {
          if (bet.freebet) {
            totalReturn += bet.profit || (stakeVal * boostMult);
          } else {
            totalReturn += liability + (bet.profit || (stakeVal * boostMult));
          }
        } else {
          if (bet.freebet) {
            totalReturn += ((stakeVal * oddVal) - stakeVal) * boostMult;
          } else {
            totalReturn += ((stakeVal * oddVal) - stakeVal) * boostMult + stakeVal;
          }
        }
      } else if (bet.status === 'red') {
        if (!bet.freebet) {
          totalLost += riskVal;
        }
      } else if (bet.status === 'refunded') {
        if (!bet.freebet) {
          totalReturn += riskVal;
        }
      }
      
      netProfit += bet.profit || 0;
    });

    const dayBetsTotal = (group.bets || []).length;

    const sessionDetails = group.sessions.map((sess, idx) => {
      let sessStaked = 0;
      let sessReturn = 0;
      let sessProfit = 0;

      (sess.bets || []).forEach(b => {
        const stakeVal = parseFloat(b.stake) || 0;
        const oddVal = parseFloat(b.odd) || 0;
        const isLay = b.exchangeType === 'lay';
        const liability = (isLay && stakeVal > 0 && oddVal > 1) ? (stakeVal * (oddVal - 1)) : 0;
        const riskVal = isLay ? liability : stakeVal;
        const boostMult = (b.boostActive && b.boostPercent > 0) ? (1 + (parseFloat(b.boostPercent) / 100)) : 1;

        if (!b.freebet) sessStaked += riskVal;
        if (b.status === 'green') {
          if (isLay) {
            sessReturn += b.freebet ? (b.profit || (stakeVal * boostMult)) : (liability + (b.profit || (stakeVal * boostMult)));
          } else {
            sessReturn += b.freebet ? (b.profit || (((stakeVal * oddVal) - stakeVal) * boostMult)) : (stakeVal + (b.profit || (((stakeVal * oddVal) - stakeVal) * boostMult)));
          }
        } else if (b.status === 'refunded' && !b.freebet) {
          sessReturn += riskVal;
        }
        sessProfit += b.profit || 0;
      });

      return {
        title: sess.notes && sess.notes.trim() ? sess.notes.trim() : `Sessão #${idx + 1}`,
        staked: sessStaked,
        returnVal: sessReturn,
        profit: sessProfit,
        betsCount: (sess.bets || []).length
      };
    });

    grandTotalStaked += totalStaked;
    grandTotalReturn += totalReturn;
    grandTotalLost += totalLost;
    grandNetProfit += netProfit;
    grandTotalBets += dayBetsTotal;

    const formattedDate = formatDate(dateKey);
    const notesJoined = Array.from(new Set(group.notes)).join(' • ') || '-';

    return {
      dateKey,
      formattedDate,
      notesJoined,
      totalStaked,
      totalReturn,
      totalLost,
      netProfit,
      dayBetsTotal,
      sessionsCount: group.sessions.length,
      sessionDetails
    };
  });

  return {
    dateGroups,
    grandTotalStaked,
    grandTotalReturn,
    grandTotalLost,
    grandNetProfit,
    grandTotalBets
  };
}

// Function to export Bets Summary report to CSV (Excel compatible)
function exportBetsSummaryCSV() {
  const data = getBetsSummaryData();
  if (!data.dateGroups || data.dateGroups.length === 0) {
    alert("Nenhum dia de apostas registrado para baixar o relatório.");
    return;
  }

  let csv = '\uFEFF'; // UTF-8 BOM for Excel PT-BR compatibility
  const tzoffset = (new Date()).getTimezoneOffset() * 60000;
  const localDateStr = (new Date(Date.now() - tzoffset)).toISOString().slice(0, 10);
  
  csv += 'RELATÓRIO DE RESUMO DE APOSTAS POR DIA - PLANILHA GULOSA\n';
  csv += `Gerado em;${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}\n`;
  csv += `Total de Dias Registrados;${data.dateGroups.length}\n`;
  csv += `Total Apostado Geral (R$);${data.grandTotalStaked.toFixed(2).replace('.', ',')}\n`;
  csv += `Retorno Total Geral (R$);${data.grandTotalReturn.toFixed(2).replace('.', ',')}\n`;
  csv += `Lucro Líquido Geral (R$);${data.grandNetProfit.toFixed(2).replace('.', ',')}\n\n`;

  csv += 'Data / Dia;Observações / Notas;Qtd Sessões;Qtd Apostas;Total Apostado (R$);Retorno Total (R$);Lucro Líquido do Dia (R$);Resultado\n';

  data.dateGroups.forEach(item => {
    const cleanNotes = item.notesJoined.replace(/;/g, ',').replace(/\n/g, ' ');
    const statusText = item.netProfit > 0 ? 'Lucro' : (item.netProfit < 0 ? 'Prejuízo' : 'Empate');
    
    csv += `"${item.formattedDate}";"${cleanNotes}";${item.sessionsCount};${item.dayBetsTotal};${item.totalStaked.toFixed(2).replace('.', ',')};${item.totalReturn.toFixed(2).replace('.', ',')};${item.netProfit.toFixed(2).replace('.', ',')};"${statusText}"\n`;
  });

  csv += `TOTAL GERAL;;${data.dateGroups.reduce((acc, g) => acc + g.sessionsCount, 0)};${data.grandTotalBets};${data.grandTotalStaked.toFixed(2).replace('.', ',')};${data.grandTotalReturn.toFixed(2).replace('.', ',')};${data.grandNetProfit.toFixed(2).replace('.', ',')};"${data.grandNetProfit > 0 ? 'LUCRO ACUMULADO' : (data.grandNetProfit < 0 ? 'PREJUÍZO ACUMULADO' : 'NEUTRO')}"\n`;

  csv += '\n\nDETALHAMENTO DE SESSÕES POR DIA\n';
  csv += 'Data;Nome / Identificação da Sessão;Qtd Apostas;Apostado (R$);Retorno (R$);Resultado (R$)\n';
  data.dateGroups.forEach(item => {
    item.sessionDetails.forEach(sess => {
      const sessTitle = sess.title.replace(/;/g, ',').replace(/\n/g, ' ');
      csv += `"${item.formattedDate}";"${sessTitle}";${sess.betsCount};${sess.staked.toFixed(2).replace('.', ',')};${sess.returnVal.toFixed(2).replace('.', ',')};${sess.profit.toFixed(2).replace('.', ',')}\n`;
    });
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `relatorio-resumo-apostas-${localDateStr}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// Function to print / export formatted PDF report
function printBetsSummaryReport() {
  const data = getBetsSummaryData();
  if (!data.dateGroups || data.dateGroups.length === 0) {
    alert("Nenhum dia de apostas registrado para gerar o relatório de impressão.");
    return;
  }

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert("Por favor, permita janelas pop-up no navegador para abrir o relatório.");
    return;
  }

  const dateNow = new Date().toLocaleDateString('pt-BR');
  const timeNow = new Date().toLocaleTimeString('pt-BR');

  let rowsHtml = '';
  data.dateGroups.forEach(item => {
    const netClass = item.netProfit > 0 ? 'color: #10b981; font-weight: bold;' : (item.netProfit < 0 ? 'color: #f43f5e; font-weight: bold;' : 'color: #94a3b8;');
    const netPrefix = item.netProfit > 0 ? '+' : '';
    
    let sessBreakdown = '';
    item.sessionDetails.forEach(sess => {
      const sessNetClass = sess.profit > 0 ? 'color: #10b981;' : (sess.profit < 0 ? 'color: #f43f5e;' : 'color: #94a3b8;');
      sessBreakdown += `
        <div style="font-size: 11px; padding: 4px 8px; margin-top: 4px; background: #1e293b; border-radius: 6px; display: flex; justify-content: space-between; color: #cbd5e1;">
          <span><strong>${sess.title}</strong> (${sess.betsCount} apostas)</span>
          <span>Apostado: R$ ${sess.staked.toFixed(2)} | Retorno: R$ ${sess.returnVal.toFixed(2)} | Profit: <strong style="${sessNetClass}">${sess.profit > 0 ? '+' : ''}R$ ${sess.profit.toFixed(2)}</strong></span>
        </div>
      `;
    });

    rowsHtml += `
      <tr style="border-bottom: 1px solid #334155;">
        <td style="padding: 10px; font-weight: bold;">${item.formattedDate}</td>
        <td style="padding: 10px; font-size: 12px; color: #94a3b8;">${item.notesJoined}</td>
        <td style="padding: 10px; text-align: right;">R$ ${item.totalStaked.toFixed(2)}</td>
        <td style="padding: 10px; text-align: right; color: ${item.totalReturn >= item.totalStaked ? '#10b981' : '#f43f5e'};">R$ ${item.totalReturn.toFixed(2)}</td>
        <td style="padding: 10px; text-align: right; ${netClass}">${netPrefix}R$ ${item.netProfit.toFixed(2)}</td>
      </tr>
      <tr>
        <td colspan="5" style="padding: 0 10px 10px 24px;">
          ${sessBreakdown}
        </td>
      </tr>
    `;
  });

  const netGeralClass = data.grandNetProfit > 0 ? '#10b981' : (data.grandNetProfit < 0 ? '#f43f5e' : '#f8fafc');

  printWindow.document.write(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>Relatório Resumo de Apostas por Dia - Planilha Gulosa</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; background-color: #090d16; color: #f8fafc; padding: 24px; margin: 0; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #334155; padding-bottom: 16px; margin-bottom: 20px; }
        .header h1 { margin: 0; font-size: 22px; color: #818cf8; }
        .header p { margin: 4px 0 0 0; font-size: 12px; color: #94a3b8; }
        .cards { display: flex; gap: 16px; margin-bottom: 24px; }
        .card { flex: 1; background: #1e293b; border-radius: 12px; padding: 16px; border: 1px solid #334155; }
        .card-label { font-size: 11px; text-transform: uppercase; color: #94a3b8; font-weight: 600; }
        .card-val { font-size: 20px; font-weight: bold; margin-top: 6px; }
        table { width: 100%; border-collapse: collapse; background: #0f172a; border-radius: 12px; overflow: hidden; border: 1px solid #334155; }
        th { background: #1e293b; text-align: left; padding: 12px; font-size: 11px; text-transform: uppercase; color: #94a3b8; border-bottom: 1px solid #334155; }
        tfoot tr { background: #1e293b; font-weight: bold; }
        @media print {
          body { background: #fff; color: #000; padding: 0; }
          .card, table { border: 1px solid #ccc; background: #fff; color: #000; }
          th { background: #eee; color: #000; }
          .header h1 { color: #000; }
          .no-print { display: none; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <h1>Planilha Gulosa - Relatório de Apostas por Dia</h1>
          <p>Gerado em ${dateNow} às ${timeNow} | Total de Dias: ${data.dateGroups.length}</p>
        </div>
        <button class="no-print" onclick="window.print()" style="background: #6366f1; color: white; border: none; padding: 10px 18px; border-radius: 10px; font-weight: bold; cursor: pointer;">Imprimir / Salvar PDF</button>
      </div>

      <div class="cards">
        <div class="card">
          <div class="card-label">Total Apostado Geral</div>
          <div class="card-val" style="color: #f8fafc;">R$ ${data.grandTotalStaked.toFixed(2)}</div>
        </div>
        <div class="card">
          <div class="card-label">Retorno Total Geral</div>
          <div class="card-val" style="color: ${data.grandTotalReturn >= data.grandTotalStaked ? '#10b981' : '#f43f5e'};">R$ ${data.grandTotalReturn.toFixed(2)}</div>
        </div>
        <div class="card">
          <div class="card-label">Lucro Líquido Geral</div>
          <div class="card-val" style="color: ${netGeralClass};">${data.grandNetProfit > 0 ? '+' : ''}R$ ${data.grandNetProfit.toFixed(2)}</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Data / Dia</th>
            <th>Observações</th>
            <th style="text-align: right;">Total Apostado</th>
            <th style="text-align: right;">Retorno Total</th>
            <th style="text-align: right;">Lucro Líquido</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2" style="padding: 12px; font-size: 12px; text-transform: uppercase;">Total Geral Acumulado (${data.dateGroups.length} dias)</td>
            <td style="padding: 12px; text-align: right;">R$ ${data.grandTotalStaked.toFixed(2)}</td>
            <td style="padding: 12px; text-align: right; color: ${data.grandTotalReturn >= data.grandTotalStaked ? '#10b981' : '#f43f5e'};">R$ ${data.grandTotalReturn.toFixed(2)}</td>
            <td style="padding: 12px; text-align: right; color: ${netGeralClass};">${data.grandNetProfit > 0 ? '+' : ''}R$ ${data.grandNetProfit.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
    </body>
    </html>
  `);
  printWindow.document.close();
}

// ==========================================
// PNL CALENDAR
// ==========================================

let pnlCalendarMonth = '';
let pnlCalendarRange = { start: '', end: '' };

function getPnlMonthBounds(monthValue) {
  const [year, month] = (monthValue || '').split('-').map(Number);
  const safeYear = year || new Date().getFullYear();
  const safeMonth = month || (new Date().getMonth() + 1);
  const lastDay = new Date(safeYear, safeMonth, 0).getDate();
  return {
    year: safeYear,
    month: safeMonth,
    start: `${safeYear}-${String(safeMonth).padStart(2, '0')}-01`,
    end: `${safeYear}-${String(safeMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    daysInMonth: lastDay,
    firstWeekday: new Date(safeYear, safeMonth - 1, 1).getDay()
  };
}

function getPnlCalendarData() {
  const bounds = getPnlMonthBounds(pnlCalendarMonth);
  const daily = {};
  const rangeStart = pnlCalendarRange.start || bounds.start;
  const rangeEnd = pnlCalendarRange.end || bounds.end;

  (trackerData.days || []).forEach(session => {
    const date = session.date || '';
    if (date < bounds.start || date > bounds.end || date < rangeStart || date > rangeEnd) return;
    if (!daily[date]) daily[date] = { profit: 0, hasEntries: false };
    daily[date].hasEntries = true;
    (session.bets || []).forEach(bet => {
      daily[date].profit += parseFloat(bet.profit) || 0;
    });
  });

  let totalProfit = 0;
  let profitableDays = 0;
  let lossDays = 0;
  let profitAmount = 0;
  let lossAmount = 0;
  Object.values(daily).forEach(day => {
    totalProfit += day.profit;
    if (day.profit > 0) {
      profitableDays++;
      profitAmount += day.profit;
    } else if (day.profit < 0) {
      lossDays++;
      lossAmount += Math.abs(day.profit);
    }
  });

  return { bounds, daily, totalProfit, profitableDays, lossDays, profitAmount, lossAmount, rangeStart, rangeEnd };
}

function formatPnlDateRange(start, end) {
  if (!start && !end) return 'Todo o mês selecionado';
  if (start && end) return `Período: ${formatDayMonth(start)} até ${formatDayMonth(end)}`;
  return start ? `A partir de ${formatDayMonth(start)}` : `Até ${formatDayMonth(end)}`;
}

function renderPnlCalendar() {
  const grid = document.getElementById('pnl-calendar-grid');
  if (!grid) return;
  const data = getPnlCalendarData();
  const { bounds, daily, totalProfit, profitableDays, lossDays, profitAmount, lossAmount, rangeStart, rangeEnd } = data;
  const monthDate = new Date(bounds.year, bounds.month - 1, 1);
  const monthLabel = monthDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  const label = document.getElementById('pnl-month-label');
  const rangeLabel = document.getElementById('pnl-range-label');
  const totalEl = document.getElementById('pnl-total-value');
  const profitDaysEl = document.getElementById('pnl-profit-days-value');
  const lossDaysEl = document.getElementById('pnl-loss-days-value');
  const profitBar = document.getElementById('pnl-profit-bar');
  const lossBar = document.getElementById('pnl-loss-bar');

  if (label) label.textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
  if (rangeLabel) rangeLabel.textContent = formatPnlDateRange(pnlCalendarRange.start, pnlCalendarRange.end);
  if (totalEl) {
    totalEl.textContent = `${totalProfit > 0 ? '+' : ''}${formatCurrency(totalProfit)}`;
    totalEl.className = `block mt-1.5 text-xl font-extrabold ${totalProfit > 0 ? 'text-emerald-400' : (totalProfit < 0 ? 'text-rose-400' : 'text-slate-200')}`;
  }
  if (profitDaysEl) {
    profitDaysEl.textContent = `${profitableDays} / +${formatCurrency(profitAmount)}`;
    profitDaysEl.className = 'block mt-1.5 text-xl font-extrabold text-emerald-400';
  }
  if (lossDaysEl) {
    lossDaysEl.textContent = `${lossDays} / -${formatCurrency(lossAmount)}`;
    lossDaysEl.className = 'block mt-1.5 text-xl font-extrabold text-rose-400';
  }

  const totalMovement = profitAmount + lossAmount;
  if (profitBar) profitBar.style.width = `${totalMovement ? (profitAmount / totalMovement) * 100 : 0}%`;
  if (lossBar) lossBar.style.width = `${totalMovement ? (lossAmount / totalMovement) * 100 : 0}%`;

  let cells = '';
  for (let i = 0; i < bounds.firstWeekday; i++) {
    cells += '<div class="pnl-day-cell is-empty" aria-hidden="true"></div>';
  }
  for (let dayNumber = 1; dayNumber <= bounds.daysInMonth; dayNumber++) {
    const dateKey = `${bounds.year}-${String(bounds.month).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
    const dayData = daily[dateKey];
    const isInRange = dateKey >= rangeStart && dateKey <= rangeEnd;
    const profit = dayData?.profit || 0;
    const stateClass = !dayData || !isInRange ? '' : (profit > 0 ? 'has-profit' : (profit < 0 ? 'has-loss' : 'has-neutral'));
    const value = dayData && isInRange ? `${profit > 0 ? '+' : ''}${formatCurrency(profit)}` : '';
    cells += `<div class="pnl-day-cell ${stateClass}"><span class="pnl-day-number">${dayNumber}</span><span class="pnl-day-value">${value}</span></div>`;
  }
  const usedCells = bounds.firstWeekday + bounds.daysInMonth;
  const trailingCells = (7 - (usedCells % 7)) % 7;
  for (let i = 0; i < trailingCells; i++) {
    cells += '<div class="pnl-day-cell is-empty" aria-hidden="true"></div>';
  }
  grid.innerHTML = cells;
}

function openPnlModal() {
  const modal = document.getElementById('modal-pnl');
  if (!modal) return;
  const summaryStart = summaryDateStartInput?.value || '';
  const summaryEnd = summaryDateEndInput?.value || '';
  const latestDate = [...(trackerData.days || [])].map(day => day.date).filter(Boolean).sort().pop();
  const sourceDate = summaryStart || summaryEnd || latestDate || formatLocalDateInput(new Date());
  pnlCalendarMonth = sourceDate.slice(0, 7);
  pnlCalendarRange = { start: summaryStart, end: summaryEnd };
  modal.classList.remove('hidden');
  renderPnlCalendar();
  if (window.lucide) window.lucide.createIcons({ root: modal });
}

function closePnlModal() {
  const modal = document.getElementById('modal-pnl');
  if (modal) modal.classList.add('hidden');
}

function changePnlMonth(offset) {
  const bounds = getPnlMonthBounds(pnlCalendarMonth);
  const next = new Date(bounds.year, bounds.month - 1 + offset, 1);
  pnlCalendarMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
  // Navigating to another month means the complete month becomes the period.
  pnlCalendarRange = { start: '', end: '' };
  renderPnlCalendar();
}

function roundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function downloadPnlAsPng() {
  const data = getPnlCalendarData();
  const { bounds, daily, totalProfit, profitableDays, lossDays, profitAmount, lossAmount, rangeStart, rangeEnd } = data;
  const calendarRows = Math.ceil((bounds.firstWeekday + bounds.daysInMonth) / 7);
  const canvas = document.createElement('canvas');
  canvas.width = 1400;
  canvas.height = 650 + (calendarRows * 160);
  const context = canvas.getContext('2d');
  const monthLabel = new Date(bounds.year, bounds.month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const titleMonth = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);

  context.fillStyle = '#030712';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#f8fafc';
  context.font = '800 46px Arial';
  context.fillText('Calendário PnL', 70, 82);
  context.fillStyle = '#94a3b8';
  context.font = '500 24px Arial';
  context.fillText(`${titleMonth} • ${formatPnlDateRange(pnlCalendarRange.start, pnlCalendarRange.end)}`, 70, 120);

  const stats = [
    ['Total PnL', `${totalProfit > 0 ? '+' : ''}${formatCurrency(totalProfit)}`, totalProfit > 0 ? '#34d399' : (totalProfit < 0 ? '#fb7185' : '#e2e8f0')],
    ['Dias lucrativos', `${profitableDays} / +${formatCurrency(profitAmount)}`, '#34d399'],
    ['Dias de prejuízo', `${lossDays} / -${formatCurrency(lossAmount)}`, '#fb7185']
  ];
  stats.forEach((stat, index) => {
    const x = 70 + (index * 425);
    roundRect(context, x, 160, 390, 125, 22);
    context.fillStyle = '#0f172a';
    context.fill();
    context.fillStyle = '#94a3b8';
    context.font = '700 17px Arial';
    context.fillText(stat[0].toUpperCase(), x + 25, 200);
    context.fillStyle = stat[2];
    context.font = '800 31px Arial';
    context.fillText(stat[1], x + 25, 247);
  });

  const gridX = 70;
  const gridY = 360;
  const gap = 14;
  const cellWidth = (1260 - (gap * 6)) / 7;
  const cellHeight = 128;
  ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].forEach((name, index) => {
    context.fillStyle = '#94a3b8';
    context.font = '700 18px Arial';
    context.textAlign = 'center';
    context.fillText(name, gridX + (index * (cellWidth + gap)) + (cellWidth / 2), gridY - 20);
  });

  for (let dayNumber = 1; dayNumber <= bounds.daysInMonth; dayNumber++) {
    const dateKey = `${bounds.year}-${String(bounds.month).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
    const index = bounds.firstWeekday + dayNumber - 1;
    const col = index % 7;
    const row = Math.floor(index / 7);
    const x = gridX + (col * (cellWidth + gap));
    const y = gridY + (row * (cellHeight + gap));
    const dayData = daily[dateKey];
    const inRange = dateKey >= rangeStart && dateKey <= rangeEnd;
    const profit = dayData?.profit || 0;
    context.fillStyle = dayData && inRange ? (profit > 0 ? '#064e3b' : (profit < 0 ? '#881337' : '#1e293b')) : '#0f172a';
    roundRect(context, x, y, cellWidth, cellHeight, 16);
    context.fill();
    context.fillStyle = '#e2e8f0';
    context.textAlign = 'left';
    context.font = '800 24px Arial';
    context.fillText(String(dayNumber), x + 18, y + 34);
    if (dayData && inRange) {
      context.fillStyle = profit > 0 ? '#6ee7b7' : (profit < 0 ? '#fda4af' : '#94a3b8');
      context.font = '800 20px Arial';
      context.fillText(`${profit > 0 ? '+' : ''}${formatCurrency(profit)}`, x + 18, y + 95);
    }
  }

  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `pnl-calendario-${pnlCalendarMonth}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

const btnOpenPnl = document.getElementById('btn-open-pnl');
const btnClosePnl = document.getElementById('modal-pnl-close');
const btnPnlPreviousMonth = document.getElementById('btn-pnl-prev-month');
const btnPnlNextMonth = document.getElementById('btn-pnl-next-month');
const btnDownloadPnl = document.getElementById('btn-download-pnl');
if (btnOpenPnl) btnOpenPnl.addEventListener('click', openPnlModal);
if (btnClosePnl) btnClosePnl.addEventListener('click', closePnlModal);
if (btnPnlPreviousMonth) btnPnlPreviousMonth.addEventListener('click', () => changePnlMonth(-1));
if (btnPnlNextMonth) btnPnlNextMonth.addEventListener('click', () => changePnlMonth(1));
if (btnDownloadPnl) btnDownloadPnl.addEventListener('click', downloadPnlAsPng);

// Tab Switching Listener & Hash Routing
const tabDashboard = document.getElementById('tab-dashboard');
const tabBetsSummary = document.getElementById('tab-bets-summary');
const tabCalculator = document.getElementById('tab-calculator');
const tabHistory = document.getElementById('tab-history');
const tabNotes = document.getElementById('tab-notes');
const tabFreebets = document.getElementById('tab-freebets');
const tabGoals = document.getElementById('tab-goals');
const btnFreebetHeaderCount = document.getElementById('freebet-count');

const contentDashboard = document.getElementById('content-dashboard');
const contentBetsSummary = document.getElementById('content-bets-summary');
const contentCalculator = document.getElementById('content-calculator');
const contentHistory = document.getElementById('content-history');
const contentNotes = document.getElementById('content-notes');
const contentFreebets = document.getElementById('content-freebets');
const contentGoals = document.getElementById('content-goals');
const inputSearchFreebetDays = document.getElementById('input-search-freebet-days');

function deactivateAllTabs() {
  closeMobileMenu();
  const inactiveClass = "px-4 md:px-5 py-3 text-xs md:text-sm font-semibold border-b-2 border-transparent text-slate-400 hover:text-slate-200 -mb-px transition-colors flex items-center gap-2 shrink-0";
  if (tabDashboard) tabDashboard.className = inactiveClass;
  if (tabBetsSummary) tabBetsSummary.className = inactiveClass;
  if (tabCalculator) tabCalculator.className = inactiveClass;
  if (tabHistory) tabHistory.className = inactiveClass;
  if (tabNotes) tabNotes.className = inactiveClass;
  if (tabFreebets) tabFreebets.className = inactiveClass;
  if (tabGoals) tabGoals.className = inactiveClass;
  
  if (contentDashboard) contentDashboard.classList.add('hidden');
  if (contentBetsSummary) contentBetsSummary.classList.add('hidden');
  if (contentCalculator) contentCalculator.classList.add('hidden');
  if (contentHistory) contentHistory.classList.add('hidden');
  if (contentNotes) contentNotes.classList.add('hidden');
  if (contentFreebets) contentFreebets.classList.add('hidden');
  if (contentGoals) contentGoals.classList.add('hidden');
}

const activeTabClass = "px-4 md:px-5 py-3 text-xs md:text-sm font-bold border-b-2 border-blue-500 text-blue-400 -mb-px transition-colors flex items-center gap-2 shrink-0";

function activateDashboardTab() {
  deactivateAllTabs();
  if (tabDashboard) tabDashboard.className = activeTabClass;
  if (contentDashboard) contentDashboard.classList.remove('hidden');
  if (window.location.hash !== '#dashboard') window.location.hash = 'dashboard';
}

function activateBetsSummaryTab() {
  deactivateAllTabs();
  if (tabBetsSummary) tabBetsSummary.className = activeTabClass;
  if (contentBetsSummary) contentBetsSummary.classList.remove('hidden');
  renderBetsSummary();
  if (window.location.hash !== '#bets-summary') window.location.hash = 'bets-summary';
}

function activateCalculatorTab() {
  deactivateAllTabs();
  if (tabCalculator) tabCalculator.className = activeTabClass;
  if (contentCalculator) contentCalculator.classList.remove('hidden');
  if (typeof calculateBetTracker === 'function') calculateBetTracker();
  if (window.location.hash !== '#calculator') window.location.hash = 'calculator';
}

function activateHistoryTab() {
  deactivateAllTabs();
  if (tabHistory) tabHistory.className = activeTabClass;
  if (contentHistory) contentHistory.classList.remove('hidden');
  renderHistory();
  if (window.location.hash !== '#history') window.location.hash = 'history';
}

function activateNotesTab() {
  deactivateAllTabs();
  if (tabNotes) tabNotes.className = activeTabClass;
  if (contentNotes) contentNotes.classList.remove('hidden');
  renderDailyNotes(inputSearchNotes ? inputSearchNotes.value : '');
  if (window.location.hash !== '#notes') window.location.hash = 'notes';
}

function activateFreebetsTab() {
  deactivateAllTabs();
  if (tabFreebets) tabFreebets.className = activeTabClass;
  if (contentFreebets) contentFreebets.classList.remove('hidden');
  renderFreebetDays(inputSearchFreebetDays ? inputSearchFreebetDays.value : '');
  if (window.location.hash !== '#freebets') window.location.hash = 'freebets';
}

function activateGoalsTab() {
  deactivateAllTabs();
  if (tabGoals) tabGoals.className = activeTabClass;
  if (contentGoals) contentGoals.classList.remove('hidden');
  renderGoals();
  if (window.location.hash !== '#goals') window.location.hash = 'goals';
}

// Hash Routing Handler
function handleHashNavigation() {
  const hash = window.location.hash.toLowerCase();
  if (hash === '#calculator') {
    activateCalculatorTab();
  } else if (hash === '#bets-summary') {
    activateBetsSummaryTab();
  } else if (hash === '#history') {
    activateHistoryTab();
  } else if (hash === '#notes') {
    activateNotesTab();
  } else if (hash === '#freebets') {
    activateFreebetsTab();
  } else if (hash === '#goals') {
    activateGoalsTab();
  } else {
    // Default or #dashboard
    if (contentDashboard && contentDashboard.classList.contains('hidden')) {
      activateDashboardTab();
    }
  }
}

window.addEventListener('hashchange', handleHashNavigation);

if (tabDashboard) tabDashboard.addEventListener('click', activateDashboardTab);
if (tabBetsSummary) tabBetsSummary.addEventListener('click', activateBetsSummaryTab);
if (tabCalculator) tabCalculator.addEventListener('click', activateCalculatorTab);
if (tabHistory) tabHistory.addEventListener('click', activateHistoryTab);
if (tabNotes) tabNotes.addEventListener('click', activateNotesTab);
if (tabFreebets) tabFreebets.addEventListener('click', activateFreebetsTab);
if (tabGoals) tabGoals.addEventListener('click', activateGoalsTab);

const btnSaveGoal = document.getElementById('btn-save-goal');
if (btnSaveGoal) btnSaveGoal.addEventListener('click', saveGoal);

if (btnFreebetHeaderCount) btnFreebetHeaderCount.addEventListener('click', activateFreebetsTab);

if (inputSearchFreebetDays) {
  inputSearchFreebetDays.addEventListener('input', (e) => {
    renderFreebetDays(e.target.value);
  });
}

// ==========================================
// CALCULADORA BET TRACKER (MOTOR DE CÁLCULO)
// ==========================================

let calcState = {
  mode: 'surebet', // 'surebet' | 'freebet'
  rounding: 'none', // 'none' | '1' | '5' | '10'
  entries: [
    { id: 1, house: '', odd: '', type: 'real', comm: '', calculatedStake: 0 },
    { id: 2, house: '', odd: '', type: 'real', comm: '', calculatedStake: 0 }
  ]
};

function renderCalcEntries() {
  const container = document.getElementById('calc-entries-container');
  if (!container) return;

  const isRemoveable = calcState.entries.length > 2;

  container.innerHTML = calcState.entries.map((entry, index) => {
    const housePlaceholder = `Ex: Seleção / Casa ${index + 1}`;
    const oddPlaceholder = `Ex: 2.10`;
    const commPlaceholder = `0%`;
    const stakeValueDisplay = entry.calculatedStake ? entry.calculatedStake.toFixed(2) : '';

    return `
      <div class="grid grid-cols-1 sm:grid-cols-12 gap-3 p-4 bg-slate-900/60 rounded-xl border ${entry.isLocked ? 'border-amber-500/50 bg-amber-950/10' : 'border-slate-800/80'} items-center relative transition-all">
        <div class="${isRemoveable ? 'sm:col-span-3' : 'sm:col-span-3'}">
          <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Casa / Seleção ${index + 1}</label>
          <input type="text" data-entry-field="house" data-entry-index="${index}" value="${entry.house || ''}" placeholder="${housePlaceholder}" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-medium focus:border-blue-500 focus:outline-none">
        </div>

        <div class="sm:col-span-2">
          <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Odd Aposta ${index + 1}</label>
          <input type="number" step="0.01" min="1.01" data-entry-field="odd" data-entry-index="${index}" value="${entry.odd || ''}" placeholder="${oddPlaceholder}" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-emerald-400 font-bold focus:border-blue-500 focus:outline-none">
        </div>

        <div class="${isRemoveable ? 'sm:col-span-3' : 'sm:col-span-3'}">
          <div class="flex items-center justify-between mb-1">
            <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-400">Stake Aposta ${index + 1} (R$)</label>
            <button type="button" data-lock-entry-index="${index}" class="btn-lock-stake text-[10px] flex items-center gap-1 font-bold transition-all px-2 py-0.5 rounded-md border ${entry.isLocked ? 'bg-amber-500/20 text-amber-400 border-amber-500/40 shadow-sm shadow-amber-500/10' : 'text-slate-500 hover:text-slate-300 bg-slate-950 border-slate-800'}" title="${entry.isLocked ? 'Stake Fixa (Trancada). Clique para destrancar.' : 'Trancar valor nesta odd para calcular as outras entradas'}">
              <i data-lucide="${entry.isLocked ? 'lock' : 'unlock'}" class="w-3 h-3"></i>
              <span>${entry.isLocked ? 'Trancada' : 'Fixar'}</span>
            </button>
          </div>
          <input type="number" step="0.01" min="0" id="calc-stake-display-${index}" data-entry-field="calculatedStake" data-entry-index="${index}" value="${stakeValueDisplay}" placeholder="Ex: 50.00" class="w-full bg-slate-950 border ${entry.isLocked ? 'border-amber-500/60 ring-1 ring-amber-500/30' : 'border-slate-800'} rounded-lg px-3 py-2 text-xs text-blue-300 font-bold focus:border-blue-500 focus:outline-none transition-all">
        </div>

        <div class="sm:col-span-2">
          <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Tipo de Saldo</label>
          <select data-entry-field="type" data-entry-index="${index}" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 text-xs text-slate-200 font-medium focus:border-blue-500 focus:outline-none">
            <option value="real" ${entry.type === 'real' ? 'selected' : ''}>Saldo Real</option>
            <option value="freebet_snr" ${entry.type === 'freebet_snr' ? 'selected' : ''}>Freebet SNR</option>
            <option value="freebet_sr" ${entry.type === 'freebet_sr' ? 'selected' : ''}>Freebet SR</option>
          </select>
        </div>

        <div class="${isRemoveable ? 'sm:col-span-1' : 'sm:col-span-2'}">
          <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Comissão</label>
          <input type="number" step="0.5" min="0" max="100" data-entry-field="comm" data-entry-index="${index}" value="${entry.comm || ''}" placeholder="${commPlaceholder}" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 text-xs text-slate-300 font-medium focus:border-blue-500 focus:outline-none">
        </div>

        ${isRemoveable ? `
          <div class="sm:col-span-1 flex items-center justify-center pt-2 sm:pt-4">
            <button type="button" data-remove-entry-index="${index}" class="p-2 text-slate-400 hover:text-rose-400 bg-slate-950 border border-slate-800 rounded-lg hover:border-rose-500/40 transition-colors" title="Remover seleção">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  // Event Listeners dos Inputs Dinâmicos
  const inputs = container.querySelectorAll('input, select');
  inputs.forEach(input => {
    const field = input.getAttribute('data-entry-field');
    const idx = parseInt(input.getAttribute('data-entry-index'), 10);
    if (field && !isNaN(idx) && calcState.entries[idx]) {
      const handler = (e) => {
        if (field === 'calculatedStake') {
          const val = parseFloat(e.target.value) || 0;
          calcState.entries[idx].calculatedStake = val;
          if (calcState.entries[idx].isLocked) {
            calcState.entries[idx].lockedStake = val;
          } else {
            calcState.entries[idx].manualStake = val;
            calcState.entries[idx].isManual = true;
          }
        } else {
          calcState.entries[idx][field] = e.target.value;
          if (field === 'odd' || field === 'type') {
            calcState.entries[idx].isManual = false;
          }
        }
        calculateBetTracker();
      };
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    }
  });

  // Event Listeners dos Botões de Cadeado / Fixar Stake
  const lockBtns = container.querySelectorAll('[data-lock-entry-index]');
  lockBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const idx = parseInt(btn.getAttribute('data-lock-entry-index'), 10);
      if (!isNaN(idx) && calcState.entries[idx]) {
        const targetEntry = calcState.entries[idx];
        const isAlreadyLocked = !!targetEntry.isLocked;
        const hasManualOverrides = calcState.entries.some(entry => entry.isManual);

        if (isAlreadyLocked) {
          if (hasManualOverrides) {
            // Se já estava trancada e houveram edições manuais/acidentais em outras apostas,
            // mantém a entrada trancada e limpa os overrides manuais para recalcular todas as apostas!
            calcState.entries.forEach(entry => {
              entry.isManual = false;
              entry.manualStake = undefined;
            });
          } else {
            // Se já estava trancada sem edições manuais pendentes, o clique destranca a entrada (toggle off)
            targetEntry.isLocked = false;
            calcState.entries.forEach(entry => {
              entry.isManual = false;
              entry.manualStake = undefined;
            });
          }
        } else {
          // Destranca todas as outras seleções para manter apenas a selecionada trancada
          calcState.entries.forEach((entry, i) => {
            if (i !== idx) {
              entry.isLocked = false;
            }
            entry.isManual = false;
            entry.manualStake = undefined;
          });

          targetEntry.isLocked = true;

          // Se a entrada foi editada manualmente ou não tem lockedStake válido, usa o valor atual ou 100
          const currentVal = parseFloat(targetEntry.calculatedStake);
          if (targetEntry.isManual || !targetEntry.lockedStake || targetEntry.lockedStake <= 0 || isNaN(targetEntry.lockedStake)) {
            targetEntry.lockedStake = (!isNaN(currentVal) && currentVal > 0) ? currentVal : 100;
          }
          targetEntry.calculatedStake = targetEntry.lockedStake;
        }

        renderCalcEntries();
        calculateBetTracker();
      }
    });
  });

  // Event Listeners dos Botões de Lixeira / Exclusão
  const removeBtns = container.querySelectorAll('[data-remove-entry-index]');
  removeBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const idx = parseInt(btn.getAttribute('data-remove-entry-index'), 10);
      if (!isNaN(idx) && calcState.entries.length > 2) {
        calcState.entries.splice(idx, 1);
        renderCalcEntries();
        calculateBetTracker();
      }
    });
  });

  if (window.lucide) window.lucide.createIcons();
}

function initBetTrackerCalculator() {
  // Renderizar entradas iniciais vazias
  renderCalcEntries();

  // Selectores de Modo
  const btnModeSurebet = document.getElementById('calc-mode-surebet');
  const btnModeFreebet = document.getElementById('calc-mode-freebet');

  const modeButtons = [
    { btn: btnModeSurebet, mode: 'surebet', name: 'Surebet & Arbitragem' },
    { btn: btnModeFreebet, mode: 'freebet', name: 'Freebet (SNR/SR)' }
  ];

  modeButtons.forEach(item => {
    if (!item.btn) return;
    item.btn.addEventListener('click', () => {
      calcState.mode = item.mode;
      calcState.entries.forEach(e => {
        e.isManual = false;
        e.isLocked = false;
      });
      modeButtons.forEach(b => {
        if (!b.btn) return;
        if (b.mode === item.mode) {
          b.btn.className = "calc-mode-btn px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 text-white shadow-sm transition-colors flex items-center gap-1.5 shrink-0";
        } else {
          b.btn.className = "calc-mode-btn px-3.5 py-2 text-xs font-semibold rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-all flex items-center gap-1.5 shrink-0";
        }
      });
      const badge = document.getElementById('calc-current-mode-badge');
      if (badge) badge.textContent = item.name;

      if (item.mode === 'freebet' && calcState.entries.length > 0) {
        calcState.entries[0].type = 'freebet_snr';
        renderCalcEntries();
      }

      calculateBetTracker();
    });
  });

  // Input de Investimento Total
  const inputTotalInv = document.getElementById('calc-total-investment');
  if (inputTotalInv) {
    const handleTotalInvChange = () => {
      if (document.activeElement === inputTotalInv) {
        calcState.entries.forEach(e => {
          e.isLocked = false;
          e.isManual = false;
          e.manualStake = undefined;
        });
        renderCalcEntries();
      } else if (!calcState.entries.some(e => e.isLocked)) {
        calcState.entries.forEach(e => e.isManual = false);
      }
      calculateBetTracker();
    };
    inputTotalInv.addEventListener('input', handleTotalInvChange);
    inputTotalInv.addEventListener('change', handleTotalInvChange);
  }

  // Arredondamento Select
  const selectRounding = document.getElementById('calc-rounding-select');
  if (selectRounding) {
    selectRounding.addEventListener('change', (e) => {
      calcState.rounding = e.target.value;
      calculateBetTracker();
    });
  }

  // Botão Adicionar Seleção (+)
  const btnAddEntry = document.getElementById('calc-btn-add-entry');
  if (btnAddEntry) {
    btnAddEntry.addEventListener('click', () => {
      const nextId = Date.now();
      calcState.entries.push({ id: nextId, house: '', odd: '', type: 'real', comm: '', calculatedStake: 0, isLocked: false });
      renderCalcEntries();
      calculateBetTracker();
    });
  }

  // Botão Limpar / Reset
  const btnReset = document.getElementById('calc-btn-reset');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      if (inputTotalInv) inputTotalInv.value = '';
      calcState.entries = [
        { id: 1, house: '', odd: '', type: 'real', comm: '', calculatedStake: 0, isLocked: false },
        { id: 2, house: '', odd: '', type: 'real', comm: '', calculatedStake: 0, isLocked: false }
      ];
      renderCalcEntries();
      calculateBetTracker();
    });
  }

  // Botão Exportar para Planilha
  const btnExportSheet = document.getElementById('calc-btn-export-sheet');
  if (btnExportSheet) {
    btnExportSheet.addEventListener('click', openExportCalcModal);
  }

  // Alternador do Modo de Exportação (Novo Dia vs Dia Existente)
  const btnTargetNew = document.getElementById('calc-export-target-new');
  const btnTargetExisting = document.getElementById('calc-export-target-existing');
  const containerNew = document.getElementById('calc-export-container-new');
  const containerExisting = document.getElementById('calc-export-container-existing');

  if (btnTargetNew && btnTargetExisting) {
    btnTargetNew.addEventListener('click', () => {
      calcState.exportMode = 'new';
      btnTargetNew.className = "px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white border border-blue-500 transition-all flex items-center justify-center gap-1.5 shadow-sm";
      btnTargetExisting.className = "px-3 py-2 text-xs font-medium text-slate-400 bg-slate-900 border border-slate-800 rounded-lg hover:text-slate-200 transition-all flex items-center justify-center gap-1.5";
      if (containerNew) containerNew.classList.remove('hidden');
      if (containerExisting) containerExisting.classList.add('hidden');
    });

    btnTargetExisting.addEventListener('click', () => {
      calcState.exportMode = 'existing';
      btnTargetExisting.className = "px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white border border-blue-500 transition-all flex items-center justify-center gap-1.5 shadow-sm";
      btnTargetNew.className = "px-3 py-2 text-xs font-medium text-slate-400 bg-slate-900 border border-slate-800 rounded-lg hover:text-slate-200 transition-all flex items-center justify-center gap-1.5";
      if (containerExisting) containerExisting.classList.remove('hidden');
      if (containerNew) containerNew.classList.add('hidden');
    });
  }

  // Modal Export Listeners
  const modalClose = document.getElementById('modal-calc-export-close');
  const modalCancel = document.getElementById('modal-calc-export-cancel');
  const modalConfirm = document.getElementById('modal-calc-export-confirm');

  if (modalClose) modalClose.addEventListener('click', closeExportCalcModal);
  if (modalCancel) modalCancel.addEventListener('click', closeExportCalcModal);
  if (modalConfirm) modalConfirm.addEventListener('click', confirmExportCalcToTracker);
}

function applyStakeRounding(val, type) {
  if (type === '1') return Math.round(val);
  if (type === '5') return Math.round(val / 5) * 5 || 5;
  if (type === '10') return Math.round(val / 10) * 10 || 10;
  return val;
}

function calculateBetTracker() {
  let totalInv = parseFloat(document.getElementById('calc-total-investment')?.value) || 0;

  // Extração das odds e dados das entradas
  const parsedEntries = calcState.entries.map(e => ({
    house: e.house || '',
    odd: parseFloat(e.odd) || 0,
    type: e.type || 'real',
    comm: (parseFloat(e.comm) || 0) / 100
  }));

  const resProfit = document.getElementById('calc-res-profit');
  const resRoi = document.getElementById('calc-res-roi');
  const badgeSurebet = document.getElementById('calc-badge-surebet');
  const resTotalInvested = document.getElementById('calc-res-total-invested');
  const resAvgPayout = document.getElementById('calc-res-avg-payout');
  const resModeLabel = document.getElementById('calc-res-mode-label');
  const tbody = document.getElementById('calc-scenarios-tbody');

  const hasValidOdds = parsedEntries.every(e => e.odd > 1.0);

  if (!hasValidOdds) {
    calcState.entries.forEach((e, idx) => {
      if (!e.isManual && !e.isLocked) e.calculatedStake = 0;
      const el = document.getElementById(`calc-stake-display-${idx}`);
      if (el && document.activeElement !== el) {
        el.value = e.calculatedStake ? e.calculatedStake.toFixed(2) : '';
      }
    });

    if (resProfit) {
      resProfit.textContent = 'R$ 0,00';
      resProfit.className = "text-3xl font-black text-slate-400 tracking-tight mt-1";
    }

    if (resRoi) {
      resRoi.innerHTML = `<i data-lucide="info" class="w-3.5 h-3.5"></i> Digite as odds para calcular`;
      resRoi.className = "text-xs font-semibold text-slate-400 mt-1 flex items-center gap-1";
    }

    if (badgeSurebet) {
      badgeSurebet.textContent = "Aguardando Dados";
      badgeSurebet.className = "px-2.5 py-1 text-[10px] font-extrabold uppercase rounded-full bg-slate-800 text-slate-400 border border-slate-700";
    }

    if (resTotalInvested) resTotalInvested.textContent = 'R$ 0,00';
    if (resAvgPayout) resAvgPayout.textContent = 'R$ 0,00';

    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="py-8 text-center text-slate-500 text-xs font-medium">
            Preencha o <strong>Valor Total a Apostar</strong> e as <strong>Odds</strong> de todas as entradas acima para visualizar a análise dos cenários.
          </td>
        </tr>
      `;
    }

    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // Fator multiplicador líquido por aposta
  const getMultiplier = (odd, type, comm) => {
    if (type === 'freebet_snr') {
      return (odd - 1) * (1 - comm);
    }
    if (type === 'freebet_sr') {
      return odd * (1 - comm);
    }
    // Saldo Real
    return 1 + (odd - 1) * (1 - comm);
  };

  const multipliers = parsedEntries.map(e => getMultiplier(e.odd, e.type, e.comm));

  // Verificar se existe alguma entrada trancada com o cadeado (isLocked)
  const lockedIdx = calcState.entries.findIndex(e => e.isLocked && (parseFloat(e.lockedStake) > 0 || parseFloat(e.calculatedStake) > 0));

  let rawStakes = [];

  // Função auxiliar para calcular retorno de uma aposta
  const getGrossReturn = (stake, odd, type, comm) => {
    if (stake <= 0) return 0;
    if (type === 'freebet_snr') return stake * (odd - 1) * (1 - comm);
    if (type === 'freebet_sr') return stake * odd * (1 - comm);
    return stake + stake * (odd - 1) * (1 - comm);
  };

  if (lockedIdx !== -1) {
    // MODO CADEADO ATIVO: A aposta trancada fixa a meta de retorno (Target Net Payout)
    const lockedEntry = calcState.entries[lockedIdx];
    const lockedStakeVal = parseFloat(lockedEntry.lockedStake) || parseFloat(lockedEntry.calculatedStake) || 0;
    const lockedOdd = parsedEntries[lockedIdx].odd;
    const lockedType = parsedEntries[lockedIdx].type;
    const lockedComm = parsedEntries[lockedIdx].comm;

    const targetNetWin = getGrossReturn(lockedStakeVal, lockedOdd, lockedType, lockedComm);

    rawStakes = parsedEntries.map((e, idx) => {
      if (idx === lockedIdx) {
        return lockedStakeVal;
      }
      if (calcState.entries[idx]?.isLocked && parseFloat(calcState.entries[idx]?.lockedStake) > 0) {
        return parseFloat(calcState.entries[idx].lockedStake);
      }
      const m = multipliers[idx];
      if (m <= 0) return 0;
      return targetNetWin / m;
    });

  } else {
    // MODO PADRÃO SEM CADEADO: Distribuição regular por Investimento Total
    if (calcState.mode === 'freebet') {
      rawStakes[0] = totalInv;
      const targetNetWin1 = rawStakes[0] * multipliers[0];
      for (let i = 1; i < parsedEntries.length; i++) {
        const m = multipliers[i];
        rawStakes[i] = (m > 1) ? (targetNetWin1 / (m - 1)) : 0;
      }
    } else {
      // Surebet / Arbitragem Padrão
      const P = multipliers.reduce((acc, m) => acc + (1 / m), 0);
      rawStakes = multipliers.map(m => totalInv / (m * P));
    }
  }

  // Aplicar Arredondamento ou manter override manual / trancado
  const finalStakes = rawStakes.map((s, idx) => {
    if (calcState.entries[idx]?.isLocked && !isNaN(calcState.entries[idx]?.lockedStake)) {
      return calcState.entries[idx].lockedStake;
    }
    if (calcState.entries[idx]?.isManual && !isNaN(calcState.entries[idx]?.manualStake)) {
      return calcState.entries[idx].manualStake;
    }
    return Math.max(0, applyStakeRounding(s, calcState.rounding));
  });

  // Atualizar calcState e displays de stake
  finalStakes.forEach((stake, idx) => {
    if (calcState.entries[idx]) calcState.entries[idx].calculatedStake = stake;
    const el = document.getElementById(`calc-stake-display-${idx}`);
    if (el && document.activeElement !== el) {
      el.value = stake > 0 ? (calcState.rounding !== 'none' ? stake.toFixed(0) : stake.toFixed(2)) : '';
    }
  });

  // Recalcular Investimento Real Total a partir das stakes FINAIS (arredondadas)
  const totalRealInvested = parsedEntries.reduce((acc, e, idx) => {
    return acc + (e.type === 'real' ? finalStakes[idx] : 0);
  }, 0);

  // Se o modo cadeado estiver ativo, atualizar o campo "Valor Total a Apostar" com a soma exata das stakes reais arredondadas
  if (lockedIdx !== -1) {
    const inputTotalInv = document.getElementById('calc-total-investment');
    if (inputTotalInv && document.activeElement !== inputTotalInv) {
      inputTotalInv.value = totalRealInvested > 0 ? (calcState.rounding !== 'none' ? totalRealInvested.toFixed(0) : totalRealInvested.toFixed(2)) : '';
    }
  }

  // Recalcular retornos por cenário
  const scenarios = parsedEntries.map((e, idx) => {
    const houseName = e.house || `Seleção ${idx + 1}`;
    const grossReturn = getGrossReturn(finalStakes[idx], e.odd, e.type, e.comm);
    const netProfit = grossReturn - totalRealInvested;
    const roi = totalRealInvested > 0 ? (netProfit / totalRealInvested * 100) : 100;

    return {
      name: `Vitória ${houseName}`,
      house: houseName,
      stake: finalStakes[idx],
      grossReturn,
      netProfit,
      roi
    };
  });

  const minNetProfit = Math.min(...scenarios.map(s => s.netProfit));
  const avgGrossReturn = scenarios.reduce((acc, s) => acc + s.grossReturn, 0) / scenarios.length;
  const isPositive = minNetProfit >= 0;

  if (resProfit) {
    resProfit.textContent = (minNetProfit >= 0 ? '+R$ ' : '-R$ ') + Math.abs(minNetProfit).toFixed(2).replace('.', ',');
    resProfit.className = minNetProfit >= 0 ? "text-3xl font-black text-emerald-400 tracking-tight mt-1" : "text-3xl font-black text-rose-400 tracking-tight mt-1";
  }

  if (resRoi) {
    const minRoi = totalRealInvested > 0 ? (minNetProfit / totalRealInvested * 100) : 100;
    const roiFormatted = (minRoi >= 0 ? '+' : '') + minRoi.toFixed(2) + '%';
    resRoi.innerHTML = minRoi >= 0 
      ? `<i data-lucide="trending-up" class="w-3.5 h-3.5"></i> ${roiFormatted} de Arbitragem`
      : `<i data-lucide="trending-down" class="w-3.5 h-3.5"></i> ${roiFormatted} de Margem`;
    resRoi.className = minRoi >= 0 ? "text-xs font-bold text-emerald-400 mt-1 flex items-center gap-1" : "text-xs font-bold text-rose-400 mt-1 flex items-center gap-1";
  }

  if (badgeSurebet) {
    if (calcState.mode === 'freebet') {
      const freebetRetention = (minNetProfit / (finalStakes[0] || 1)) * 100;
      badgeSurebet.textContent = `Extração Freebet: ${freebetRetention.toFixed(1)}%`;
      badgeSurebet.className = "px-2.5 py-1 text-[10px] font-semibold uppercase rounded-full bg-blue-950/60 text-blue-300 border border-blue-800/60";
    } else if (isPositive) {
      badgeSurebet.textContent = "Surebet Positiva";
      badgeSurebet.className = "px-2.5 py-1 text-[10px] font-extrabold uppercase rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
    } else {
      badgeSurebet.textContent = "Prejuízo / Sem Arbitragem";
      badgeSurebet.className = "px-2.5 py-1 text-[10px] font-extrabold uppercase rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30";
    }
  }

  if (resTotalInvested) resTotalInvested.textContent = 'R$ ' + totalRealInvested.toFixed(2).replace('.', ',');
  if (resAvgPayout) resAvgPayout.textContent = 'R$ ' + avgGrossReturn.toFixed(2).replace('.', ',');

  if (resModeLabel) {
    const modeNames = {
      surebet: 'Arbitragem Normal',
      freebet: 'Extração de Freebet'
    };
    resModeLabel.textContent = modeNames[calcState.mode] || 'Calculadora';
  }

  if (tbody) {
    tbody.innerHTML = scenarios.map(sc => `
      <tr class="hover:bg-slate-900/40 transition-colors">
        <td class="py-3 px-3 font-semibold text-slate-200">${escapeHTML(sc.name)}</td>
        <td class="py-3 px-3 text-slate-300 font-medium">R$ ${sc.stake.toFixed(2).replace('.', ',')}</td>
        <td class="py-3 px-3 text-emerald-400 font-bold">R$ ${sc.grossReturn.toFixed(2).replace('.', ',')}</td>
        <td class="py-3 px-3 font-extrabold ${sc.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}">
          ${sc.netProfit >= 0 ? '+' : ''}R$ ${sc.netProfit.toFixed(2).replace('.', ',')}
        </td>
        <td class="py-3 px-3 text-right font-bold ${sc.roi >= 0 ? 'text-emerald-400' : 'text-rose-400'}">
          ${sc.roi >= 0 ? '+' : ''}${sc.roi.toFixed(2)}%
        </td>
      </tr>
    `).join('');
  }

  if (window.lucide) window.lucide.createIcons();
}

// Modal Exportar Entradas para Planilha
function openExportCalcModal() {
  const modal = document.getElementById('modal-export-calc');
  const dateSelect = document.getElementById('modal-calc-export-date-select');
  const previewList = document.getElementById('modal-calc-preview-list');
  const inputDate = document.getElementById('input-calc-export-date');
  const inputDayNotes = document.getElementById('input-calc-export-day-notes');
  if (!modal || !previewList) return;

  // Definir modo padrão como 'new' (Criar Novo Dia)
  calcState.exportMode = 'new';
  const btnTargetNew = document.getElementById('calc-export-target-new');
  const btnTargetExisting = document.getElementById('calc-export-target-existing');
  const containerNew = document.getElementById('calc-export-container-new');
  const containerExisting = document.getElementById('calc-export-container-existing');

  if (btnTargetNew && btnTargetExisting) {
    btnTargetNew.className = "px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white border border-blue-500 transition-all flex items-center justify-center gap-1.5 shadow-sm";
    btnTargetExisting.className = "px-3 py-2 text-xs font-medium text-slate-400 bg-slate-900 border border-slate-800 rounded-lg hover:text-slate-200 transition-all flex items-center justify-center gap-1.5";
    if (containerNew) containerNew.classList.remove('hidden');
    if (containerExisting) containerExisting.classList.add('hidden');
  }

  // Preencher data de hoje no formato local (YYYY-MM-DD)
  const tzoffset = (new Date()).getTimezoneOffset() * 60000;
  const todayStr = (new Date(Date.now() - tzoffset)).toISOString().slice(0, 10);

  if (inputDate) inputDate.value = todayStr;
  if (inputDayNotes) inputDayNotes.value = '';

  // Preencher select de dias existentes
  if (dateSelect) {
    if (!trackerData.days || trackerData.days.length === 0) {
      dateSelect.innerHTML = `<option value="">Nenhum dia cadastrado</option>`;
    } else {
      let optionsHtml = trackerData.days.map(d => {
        const notesText = d.notes ? ` (${d.notes})` : '';
        const dateText = formatDate(d.date);
        return `<option value="${escapeHTML(d.id)}">${escapeHTML(dateText)}${escapeHTML(notesText)}</option>`;
      }).join('');
      dateSelect.innerHTML = optionsHtml;
    }
  }

  // Preview de todas as entradas ativas da calculadora
  let previewHtml = calcState.entries.map((e, idx) => {
    const houseName = e.house || `Seleção ${idx + 1}`;
    const oddVal = parseFloat(e.odd) || 1.00;
    const stakeVal = e.calculatedStake || 0;
    const isFreebet = e.type !== 'real';

    return `
      <div class="flex items-center justify-between py-1.5 border-b border-slate-800/80 text-xs">
        <span>${idx + 1}. <strong>${escapeHTML(houseName)}</strong> @ ${oddVal.toFixed(2)} (${isFreebet ? 'Freebet' : 'Saldo Real'})</span>
        <span class="font-bold text-blue-300">R$ ${stakeVal.toFixed(2).replace('.', ',')}</span>
      </div>
    `;
  }).join('');

  previewList.innerHTML = previewHtml;
  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

function closeExportCalcModal() {
  const modal = document.getElementById('modal-export-calc');
  if (modal) modal.classList.add('hidden');
}

async function confirmExportCalcToTracker() {
  const statusSelect = document.getElementById('modal-calc-export-status');
  if (!statusSelect) return;

  const initialStatus = statusSelect.value || 'pending'; // 'pending' | 'green'

  const tzoffset = (new Date()).getTimezoneOffset() * 60000;
  const todayStr = (new Date(Date.now() - tzoffset)).toISOString().slice(0, 10);

  let targetDate = todayStr;
  let dayNotes = '';
  let targetDay = null;

  if (calcState.exportMode === 'existing') {
    const dateSelect = document.getElementById('modal-calc-export-date-select');
    const selectedDayId = dateSelect ? dateSelect.value : null;
    if (selectedDayId) {
      targetDay = trackerData.days.find(d => d.id === selectedDayId || d.date === selectedDayId);
      if (targetDay) {
        targetDate = targetDay.date;
      }
    }
  } else {
    const inputDate = document.getElementById('input-calc-export-date');
    const inputNotes = document.getElementById('input-calc-export-day-notes');
    targetDate = (inputDate && inputDate.value) ? inputDate.value : todayStr;
    dayNotes = (inputNotes && inputNotes.value) ? inputNotes.value : 'Entradas da Calculadora';
  }

  if (!targetDay) {
    targetDay = {
      id: 'day-' + Date.now(),
      date: targetDate,
      notes: dayNotes || 'Apostas da Calculadora',
      expanded: true,
      active: true,
      bets: []
    };
    trackerData.days.push(targetDay);
  } else {
    if (dayNotes) targetDay.notes = dayNotes;
    targetDay.expanded = true;
  }

  if (!targetDay.bets) targetDay.bets = [];

  const now = Date.now();
  const newBets = calcState.entries.map((e, idx) => {
    const houseName = e.house || `Seleção ${idx + 1}`;
    const oddVal = parseFloat(e.odd) || 1.01;
    const stakeVal = e.calculatedStake || 0;
    const isFreebet = e.type !== 'real';
    const freebetType = e.type === 'freebet_snr' ? 'snr' : (e.type === 'freebet_sr' ? 'sr' : 'none');

    return {
      id: 'bet-' + now + '-' + idx + '-' + Math.floor(Math.random() * 1000),
      bookmaker: houseName,
      exchangeType: 'back',
      stake: stakeVal,
      odd: oddVal,
      boostActive: isFreebet,
      boostType: freebetType,
      freebet: isFreebet,
      status: initialStatus,
      profit: initialStatus === 'green' ? (stakeVal * (oddVal - 1)) : 0
    };
  });

  targetDay.bets.push(...newBets);

  closeExportCalcModal();
  await saveData();
  renderAllDays();
  updateGlobalCapital();

  // Ir para a aba Dashboard para ver as entradas inseridas no tracker
  activateDashboardTab();

  // Rolar suavemente até o dia cadastrado
  setTimeout(() => {
    const dayEl = document.querySelector(`[data-day-id="${targetDay.id}"]`);
    if (dayEl) {
      dayEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 150);
}

// ==========================================
// RENDER LOGIC FOR DIAS COM FREEBETS
// ==========================================

function getDaysWithFreebets() {
  if (!trackerData.days) return [];
  return trackerData.days.filter(day => {
    return day.bets && day.bets.some(bet => bet.freebet === true);
  });
}

function renderFreebetDays(filterQuery = '') {
  try {
    const container = document.getElementById('freebet-days-container');
    const emptyState = document.getElementById('freebet-days-empty');

    const statAmount = document.getElementById('freebet-stat-total-amount');
    const statCount = document.getElementById('freebet-stat-total-count');
    const statReturnPercent = document.getElementById('freebet-stat-return-percent');
    const statProfit = document.getElementById('freebet-stat-profit');

    if (!container) return;

    const allFreebetDays = getDaysWithFreebets();

    let grandTotalAmount = 0;
    let grandTotalCount = 0;
    let grandTotalProfit = 0;

    allFreebetDays.forEach(day => {
      (day.bets || []).forEach(b => {
        if (b.freebet) {
          grandTotalAmount += (parseFloat(b.stake) || 0);
          grandTotalCount++;
        }
        // O lucro da operação de freebet é a soma do resultado de todas as apostas da sessão
        grandTotalProfit += (parseFloat(b.profit) || 0);
      });
    });

    const returnPercent = grandTotalAmount > 0 ? (grandTotalProfit / grandTotalAmount) * 100 : 0;

    if (statAmount) statAmount.textContent = formatCurrency(grandTotalAmount);
    if (statCount) statCount.textContent = grandTotalCount.toString();
    
    if (statReturnPercent) {
      const formattedPercent = (returnPercent >= 0 ? '+' : '') + returnPercent.toFixed(1).replace('.', ',') + '%';
      statReturnPercent.textContent = formattedPercent;
      statReturnPercent.className = `text-2xl font-bold tracking-tight ${returnPercent > 0 ? 'text-emerald-400' : (returnPercent < 0 ? 'text-rose-400' : 'text-slate-100')}`;
    }

    if (statProfit) {
      statProfit.textContent = (grandTotalProfit >= 0 ? '+' : '') + formatCurrency(grandTotalProfit);
      statProfit.className = `text-2xl font-bold tracking-tight ${grandTotalProfit > 0 ? 'text-emerald-400' : (grandTotalProfit < 0 ? 'text-rose-400' : 'text-slate-100')}`;
    }

    const sortedDays = [...allFreebetDays].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const query = (filterQuery || '').toLowerCase().trim();
    const filteredDays = sortedDays.filter(day => {
      if (!query) return true;
      const formattedD = formatDate(day.date).toLowerCase();
      const rawD = (day.date || '').toLowerCase();
      const notes = (day.notes || '').toLowerCase();
      const hasMatchingBet = (day.bets || []).some(b => b.freebet && (b.bookmaker || '').toLowerCase().includes(query));
      return formattedD.includes(query) || rawD.includes(query) || notes.includes(query) || hasMatchingBet;
    });

    container.innerHTML = '';

    // Group freebet days by date string (YYYY-MM-DD)
    const freebetDaysByDate = {};
    filteredDays.forEach(day => {
      const dStr = day.date || 'sem-data';
      if (!freebetDaysByDate[dStr]) {
        freebetDaysByDate[dStr] = [];
      }
      freebetDaysByDate[dStr].push(day);
    });

    const sortedDateKeys = Object.keys(freebetDaysByDate).sort((a, b) => b.localeCompare(a));

    if (sortedDateKeys.length === 0) {
      if (emptyState) emptyState.classList.remove('hidden');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    sortedDateKeys.forEach(dateKey => {
      const sessionsForDate = freebetDaysByDate[dateKey];
      
      // Accumulate all freebets and total operation profit for this date
      let dateFreebetBets = [];
      let dateFreebetStake = 0;
      let dateFreebetProfit = 0;
      let dateFreebetCount = 0;

      sessionsForDate.forEach(day => {
        (day.bets || []).forEach(b => {
          dateFreebetBets.push(b);
          if (b.freebet) {
            dateFreebetCount++;
            dateFreebetStake += (parseFloat(b.stake) || 0);
          }
          // Resultado da operação inteira usando a freebet (soma do lucro da freebet + cobertura LAY/BACK)
          dateFreebetProfit += (parseFloat(b.profit) || 0);
        });
      });

      const dayCard = document.createElement('div');
      dayCard.className = 'glass-card rounded-xl border border-slate-800 overflow-hidden shadow-lg transition-all duration-200 animate-slide-down';
      dayCard.setAttribute('data-freebet-date-key', dateKey);

      const formattedDate = formatDate(dateKey);

      // Collect session notes if any
      const notesList = sessionsForDate
        .map(s => (s.notes || '').trim())
        .filter(n => n.length > 0);
      const combinedNotes = notesList.length > 0 ? notesList.join(' | ') : '';

      const isExpandedByDefault = query.length > 0;

      let rowsHtml = '';
      dateFreebetBets.forEach(bet => {
        const isLay = bet.exchangeType === 'lay';
        const statusClass = bet.status === 'green' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                           (bet.status === 'red' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' :
                           (bet.status === 'refunded' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 'bg-slate-800 text-slate-400 border-slate-700'));
        const statusText = bet.status === 'green' ? 'Ganhou' : (bet.status === 'red' ? 'Perdeu' : (bet.status === 'refunded' ? 'Reembolso' : 'Pendente'));

        const profitFormatted = (bet.profit >= 0 ? '+' : '') + formatCurrency(bet.profit || 0);
        const profitColorClass = bet.profit > 0 ? 'text-emerald-400 font-bold' : (bet.profit < 0 ? 'text-rose-400 font-bold' : 'text-slate-400');

        rowsHtml += `
          <tr class="border-b border-slate-800/60 text-xs text-slate-300 hover:bg-slate-900/40 transition-colors">
            <td class="py-2.5 px-3 font-semibold text-slate-200">
              ${escapeHTML(bet.bookmaker || 'Não informada')}
            </td>
            <td class="py-2.5 px-3 uppercase text-[10px] font-bold">
              <span class="px-2 py-0.5 rounded ${isLay ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'}">
                ${isLay ? 'LAY' : 'BACK'}
              </span>
            </td>
            <td class="py-2.5 px-3 font-semibold text-blue-400">
              ${formatCurrency(bet.stake || 0)}
              ${bet.freebet ? `<span class="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-blue-500/20 text-blue-400 font-bold border border-blue-500/30">Freebet</span>` : ''}
            </td>
            <td class="py-2.5 px-3 font-mono">
              ${bet.odd ? bet.odd.toFixed(2) : '1.00'}
            </td>
            <td class="py-2.5 px-3">
              ${bet.boostActive && bet.boostPercent > 0 ? `<span class="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-bold border border-emerald-500/20">+${bet.boostPercent}%</span>` : '<span class="text-slate-600">-</span>'}
            </td>
            <td class="py-2.5 px-3">
              <span class="px-2 py-0.5 rounded border text-[11px] font-semibold ${statusClass}">
                ${statusText}
              </span>
            </td>
            <td class="py-2.5 px-3 text-right ${profitColorClass}">
              ${profitFormatted}
            </td>
          </tr>
        `;
      });

      dayCard.innerHTML = `
        <div class="freebet-day-header flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-slate-900/40 hover:bg-slate-900/70 transition-colors cursor-pointer select-none">
          
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <button type="button" class="btn-toggle-freebet-day p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-200 transition-colors shrink-0">
              <i data-lucide="chevron-right" class="chevron-icon w-5 h-5 transition-transform duration-200 ${isExpandedByDefault ? 'rotate-90' : ''}"></i>
            </button>

            <span class="text-sm font-bold text-slate-100 flex items-center gap-1.5 shrink-0">
              <i data-lucide="calendar" class="w-4 h-4 text-blue-400"></i>
              ${formattedDate}
            </span>

            <span class="text-xs px-2.5 py-0.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-full font-bold shrink-0">
              ${dateFreebetCount} ${dateFreebetCount === 1 ? 'freebet' : 'freebets'}
            </span>

            ${combinedNotes ? `<span class="text-xs text-slate-400 italic truncate max-w-[200px] sm:max-w-[320px]" title="${escapeHTML(combinedNotes)}">"${escapeHTML(combinedNotes)}"</span>` : ''}
          </div>

          <div class="flex items-center gap-4 text-xs shrink-0 self-end sm:self-auto">
            <div class="flex items-center gap-1.5">
              <span class="text-slate-450">Freebet Total:</span>
              <span class="font-bold text-blue-400 bg-blue-950/40 px-2.5 py-1 rounded-lg border border-blue-500/30">${formatCurrency(dateFreebetStake)}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="text-slate-450">Lucro Freebet:</span>
              <span class="font-bold ${dateFreebetProfit >= 0 ? 'text-emerald-400 bg-emerald-950/40 border-emerald-500/30' : 'text-rose-400 bg-rose-950/40 border-rose-500/30'} px-2.5 py-1 rounded-lg border">
                ${dateFreebetProfit >= 0 ? '+' : ''}${formatCurrency(dateFreebetProfit)}
              </span>
            </div>
          </div>
        </div>

        <div class="freebet-day-content ${isExpandedByDefault ? '' : 'hidden'} p-4 border-t border-slate-800 bg-slate-950/30">
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="border-b border-slate-800 text-[10px] uppercase font-bold text-slate-500">
                  <th class="py-2 px-3">Casa de Aposta</th>
                  <th class="py-2 px-3">Tipo</th>
                  <th class="py-2 px-3">Stake (Freebet)</th>
                  <th class="py-2 px-3">Odd</th>
                  <th class="py-2 px-3">Boost</th>
                  <th class="py-2 px-3">Status</th>
                  <th class="py-2 px-3 text-right">Resultado</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // Expand/collapse handler
      const headerEl = dayCard.querySelector('.freebet-day-header');
      const contentEl = dayCard.querySelector('.freebet-day-content');

      if (headerEl && contentEl) {
        headerEl.addEventListener('click', () => {
          const isHidden = contentEl.classList.contains('hidden');
          const icon = dayCard.querySelector('.chevron-icon, .btn-toggle-freebet-day i, .btn-toggle-freebet-day svg');
          if (isHidden) {
            contentEl.classList.remove('hidden');
            if (icon) icon.classList.add('rotate-90');
          } else {
            contentEl.classList.add('hidden');
            if (icon) icon.classList.remove('rotate-90');
          }
        });
      }

      container.appendChild(dayCard);
    });

  if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    console.error("Erro ao renderizar aba de freebets:", err);
  }
}

// Clear History Handler
const btnClearHistory = document.getElementById('btn-clear-history');
if (btnClearHistory) {
  btnClearHistory.addEventListener('click', () => {
    showConfirm('Você tem certeza que deseja limpar todo o histórico de lançamentos? A banca atual NÃO será zerada, mas o registro histórico será apagado.', () => {
      saveBalanceHistory([]);
      renderHistory();
    });
  });
}

// Delete Individual Transaction Handler
const historyTableBody = document.getElementById('history-table-body');
if (historyTableBody) {
  historyTableBody.addEventListener('click', (e) => {
    const btnDelTx = e.target.closest('.btn-delete-tx');
    if (!btnDelTx) return;

    const txId = btnDelTx.getAttribute('data-tx-id');
    const history = getBalanceHistory();
    const tx = history.find(t => t.id === txId);
    
    if (tx) {
      showConfirm(`Deseja desfazer este lançamento de ${tx.amount >= 0 ? '+' : ''}R$ ${tx.amount.toFixed(2)}? O saldo da banca será atualizado removendo este valor.`, () => {
        globalBalance -= tx.amount;
        
        const updatedHistory = history.filter(t => t.id !== txId);
        saveBalanceHistory(updatedHistory);
        
        updateGlobalCapital();
        renderHistory();
      });
    }
  });
}

// ==========================================
// BACKUP & RESTORE LOGIC
// ==========================================

const modalBackupRestore = document.getElementById('modal-backup-restore');
const btnBackupRestoreModal = document.getElementById('btn-backup-restore-modal');
const modalBackupClose = document.getElementById('modal-backup-close');

function openBackupRestoreModal() {
  closeMobileMenu();
  if (!modalBackupRestore) return;
  
  // Reset fields & alerts on open
  const fileInput = document.getElementById('input-import-file');
  if (fileInput) fileInput.value = '';
  
  const previewDiv = document.getElementById('import-preview');
  if (previewDiv) previewDiv.classList.add('hidden');
  
  const successAlert = document.getElementById('import-success-alert');
  if (successAlert) successAlert.classList.add('hidden');
  
  const errorAlert = document.getElementById('import-error-alert');
  if (errorAlert) errorAlert.classList.add('hidden');
  
  modalBackupRestore.classList.remove('hidden');
}

function closeBackupRestoreModal() {
  if (modalBackupRestore) modalBackupRestore.classList.add('hidden');
}

if (btnBackupRestoreModal) btnBackupRestoreModal.addEventListener('click', openBackupRestoreModal);
if (modalBackupClose) modalBackupClose.addEventListener('click', closeBackupRestoreModal);

// Export JSON implementation
const btnExportJson = document.getElementById('btn-export-json');
if (btnExportJson) {
  btnExportJson.addEventListener('click', () => {
    try {
      const backupData = {
        version: 1,
        timestamp: new Date().toISOString(),
        sports_betting_tracker_data: trackerData,
        planilhagulosa_global_balance: globalBalance.toString(),
        planilhagulosa_balance_history: getBalanceHistory()
      };
      
      const jsonString = JSON.stringify(backupData, null, 2);
      const blob = new Blob([jsonString], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      
      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = url;
      
      const tzoffset = (new Date()).getTimezoneOffset() * 60000;
      const localDate = (new Date(Date.now() - tzoffset)).toISOString().slice(0, 10);
      
      downloadAnchor.download = `planilha-gulosa-backup-${localDate}.json`;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      
      document.body.removeChild(downloadAnchor);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Erro ao gerar arquivo de exportação:", e);
      alert("Ocorreu um erro ao tentar exportar os dados.");
    }
  });
}

// Resumo de Apostas Export / Print Listeners
const btnExportSummaryCSV = document.getElementById('btn-export-summary-csv');
if (btnExportSummaryCSV) {
  btnExportSummaryCSV.addEventListener('click', exportBetsSummaryCSV);
}

const btnPrintSummaryReport = document.getElementById('btn-print-summary-report');
if (btnPrintSummaryReport) {
  btnPrintSummaryReport.addEventListener('click', printBetsSummaryReport);
}

// Import JSON implementation
const dropZone = document.getElementById('drop-zone');
const inputImportFile = document.getElementById('input-import-file');
let pendingBackupData = null;

if (dropZone && inputImportFile) {
  dropZone.addEventListener('click', () => {
    inputImportFile.click();
  });
  
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('border-blue-500', 'bg-indigo-950/10');
  });
  
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('border-blue-500', 'bg-indigo-950/10');
  });
  
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-blue-500', 'bg-indigo-950/10');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleBackupFile(files[0]);
    }
  });
  
  inputImportFile.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files.length > 0) {
      handleBackupFile(files[0]);
    }
  });
}

function handleBackupFile(file) {
  const successAlert = document.getElementById('import-success-alert');
  const errorAlert = document.getElementById('import-error-alert');
  const previewDiv = document.getElementById('import-preview');
  
  if (successAlert) successAlert.classList.add('hidden');
  if (errorAlert) errorAlert.classList.add('hidden');
  if (previewDiv) previewDiv.classList.add('hidden');
  
  pendingBackupData = null;
  
  if (!file.name.endsWith('.json')) {
    showImportError("Por favor, selecione apenas arquivos com extensão .json.");
    return;
  }
  
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      
      if (!data) {
        showImportError("O arquivo JSON está vazio ou inválido.");
        return;
      }
      
      let days = [];
      let parsedTrackerData = null;
      
      if (data.sports_betting_tracker_data && Array.isArray(data.sports_betting_tracker_data.days)) {
        parsedTrackerData = data.sports_betting_tracker_data;
      } else if (Array.isArray(data.days)) {
        parsedTrackerData = { days: data.days };
      } else {
        showImportError("Formato de backup inválido. Não foi possível encontrar as sessões de apostas.");
        return;
      }
      
      days = parsedTrackerData.days;
      
      let parsedBalance = 0;
      if (data.planilhagulosa_global_balance !== undefined) {
        parsedBalance = parseFloat(data.planilhagulosa_global_balance) || 0;
      }
      
      let parsedHistory = [];
      if (Array.isArray(data.planilhagulosa_balance_history)) {
        parsedHistory = data.planilhagulosa_balance_history;
      }
      
      let totalBets = 0;
      days.forEach(d => {
        if (Array.isArray(d.bets)) {
          totalBets += d.bets.length;
        }
      });
      
      pendingBackupData = {
        sports_betting_tracker_data: parsedTrackerData,
        planilhagulosa_global_balance: parsedBalance.toString(),
        planilhagulosa_balance_history: parsedHistory
      };
      
      showImportPreview(days.length, totalBets, parsedBalance);
      
    } catch (err) {
      console.error("Erro ao ler JSON:", err);
      showImportError("Erro ao interpretar o arquivo JSON. O arquivo pode estar corrompido.");
    }
  };
  
  reader.onerror = () => {
    showImportError("Erro ao ler o arquivo.");
  };
  
  reader.readAsText(file);
}

function showImportError(msg) {
  const errorAlert = document.getElementById('import-error-alert');
  const errorMsg = document.getElementById('import-error-message');
  if (errorAlert && errorMsg) {
    errorMsg.textContent = msg;
    errorAlert.classList.remove('hidden');
  }
}

function showImportPreview(daysCount, betsCount, globalBalance) {
  const previewDiv = document.getElementById('import-preview');
  const previewDays = document.getElementById('preview-days');
  const previewBets = document.getElementById('preview-bets');
  const previewBalance = document.getElementById('preview-balance');
  
  if (previewDiv && previewDays && previewBets && previewBalance) {
    previewDays.innerHTML = `Dias de apostas: <strong class="text-white">${daysCount}</strong>`;
    previewBets.innerHTML = `Total de apostas: <strong class="text-white">${betsCount}</strong>`;
    previewBalance.innerHTML = `Banca consolidada: <strong class="text-blue-400 font-bold">${formatCurrency(globalBalance)}</strong>`;
    
    previewDiv.classList.remove('hidden');
  }
}

const btnImportCancel = document.getElementById('btn-import-cancel');
const btnImportConfirm = document.getElementById('btn-import-confirm');

if (btnImportCancel) {
  btnImportCancel.addEventListener('click', () => {
    const previewDiv = document.getElementById('import-preview');
    if (previewDiv) previewDiv.classList.add('hidden');
    pendingBackupData = null;
    const fileInput = document.getElementById('input-import-file');
    if (fileInput) fileInput.value = '';
  });
}

if (btnImportConfirm) {
  btnImportConfirm.addEventListener('click', async () => {
    if (!pendingBackupData) return;
    
    try {
      trackerData = pendingBackupData.sports_betting_tracker_data || { days: [], dailyNotes: [] };
      globalBalance = parseFloat(pendingBackupData.planilhagulosa_global_balance) || 0;
      balanceHistory = pendingBackupData.planilhagulosa_balance_history || [];
      
      await saveDataImmediate();
      
      renderAllDays();
      updateGlobalCapital();
      
      const contentHistoryEl = document.getElementById('content-history');
      if (contentHistoryEl && !contentHistoryEl.classList.contains('hidden')) {
        renderHistory();
      }
      
      const contentBetsSummaryEl = document.getElementById('content-bets-summary');
      if (contentBetsSummaryEl && !contentBetsSummaryEl.classList.contains('hidden')) {
        renderBetsSummary();
      }

      const contentNotesEl = document.getElementById('content-notes');
      if (contentNotesEl && !contentNotesEl.classList.contains('hidden')) {
        renderDailyNotes(inputSearchNotes ? inputSearchNotes.value : '');
      }

      const contentFreebetsEl = document.getElementById('content-freebets');
      if (contentFreebetsEl && !contentFreebetsEl.classList.contains('hidden')) {
        renderFreebetDays(inputSearchFreebetDays ? inputSearchFreebetDays.value : '');
      }
      
      const successAlert = document.getElementById('import-success-alert');
      const previewDiv = document.getElementById('import-preview');
      
      if (previewDiv) previewDiv.classList.add('hidden');
      if (successAlert) successAlert.classList.remove('hidden');
      
      pendingBackupData = null;
      const fileInput = document.getElementById('input-import-file');
      if (fileInput) fileInput.value = '';
      
      setTimeout(() => {
        if (successAlert) successAlert.classList.add('hidden');
        closeBackupRestoreModal();
      }, 1500);
      
    } catch (err) {
      console.error("Erro ao aplicar backup:", err);
      showImportError("Não foi possível salvar os dados importados no navegador.");
    }
  });
}

// ==========================================
// DAILY NOTES LOGIC (ABA SALDO & ANOTAÇÕES)
// ==========================================

const formDailyNote = document.getElementById('form-daily-note');
const noteEditIdInput = document.getElementById('note-edit-id');
const noteDateInput = document.getElementById('note-date');
const noteTitleInput = document.getElementById('note-title');
const noteContentInput = document.getElementById('note-content');
const noteFormTitle = document.getElementById('note-form-title');
const btnSaveNoteText = document.getElementById('btn-save-note-text');
const btnCancelNoteEdit = document.getElementById('btn-cancel-note-edit');

const notesListContainer = document.getElementById('notes-list-container');
const notesEmptyState = document.getElementById('notes-empty-state');
const inputSearchNotes = document.getElementById('input-search-notes');

const notesStatTotal = document.getElementById('notes-stat-total');
const notesStatDays = document.getElementById('notes-stat-days');
const notesStatLastDate = document.getElementById('notes-stat-last-date');

// Set default date input to today YYYY-MM-DD
function setDefaultNoteDate() {
  if (noteDateInput && !noteDateInput.value) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    noteDateInput.value = `${yyyy}-${mm}-${dd}`;
  }
}

function clearNoteForm() {
  if (noteEditIdInput) noteEditIdInput.value = '';
  if (noteTitleInput) noteTitleInput.value = '';
  if (noteContentInput) noteContentInput.value = '';
  setDefaultNoteDate();

  if (noteFormTitle) {
    noteFormTitle.innerHTML = `<i data-lucide="pen-tool" class="w-5 h-5 text-blue-400"></i> Nova Anotação Diária`;
  }
  if (btnSaveNoteText) btnSaveNoteText.textContent = 'Salvar Anotação';
  if (btnCancelNoteEdit) btnCancelNoteEdit.classList.add('hidden');
  if (window.lucide) window.lucide.createIcons();
}

function renderDailyNotes(filterQuery = '') {
  if (!trackerData.dailyNotes) trackerData.dailyNotes = [];

  const notes = trackerData.dailyNotes;

  // Stats calculation
  if (notesStatTotal) notesStatTotal.textContent = notes.length;
  
  const uniqueDays = new Set(notes.map(n => n.date));
  if (notesStatDays) notesStatDays.textContent = uniqueDays.size;

  // Sort notes by date descending, then createdAt descending
  const sortedNotes = [...notes].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  if (notesStatLastDate) {
    notesStatLastDate.textContent = sortedNotes.length > 0 ? formatDate(sortedNotes[0].date) : 'Nenhum';
  }

  // Filter notes by search query if any
  const query = (filterQuery || '').toLowerCase().trim();
  const filteredNotes = sortedNotes.filter(n => {
    if (!query) return true;
    const formattedD = formatDate(n.date).toLowerCase();
    const rawD = (n.date || '').toLowerCase();
    const title = (n.title || '').toLowerCase();
    const content = (n.content || '').toLowerCase();
    return formattedD.includes(query) || rawD.includes(query) || title.includes(query) || content.includes(query);
  });

  if (!notesListContainer || !notesEmptyState) return;

  notesListContainer.innerHTML = '';

  if (filteredNotes.length === 0) {
    notesEmptyState.classList.remove('hidden');
    return;
  }

  notesEmptyState.classList.add('hidden');

  filteredNotes.forEach(note => {
    const card = document.createElement('div');
    card.className = "glass-card rounded-xl p-5 border border-slate-800 space-y-4 hover:border-slate-700 transition-all duration-200 animate-slide-down";

    const displayTitle = note.title && note.title.trim() ? note.title.trim() : null;
    const formattedDateStr = formatDate(note.date);
    const escapedContent = escapeHTML(note.content || '').trim();

    card.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
        <div class="flex flex-wrap items-center gap-3">
          <div class="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-500/10 border border-blue-500/20 text-blue-400 font-bold text-xs rounded-xl">
            <i data-lucide="calendar" class="w-3.5 h-3.5"></i>
            <span>${formattedDateStr}</span>
          </div>
          ${displayTitle ? `<span class="text-sm font-semibold text-slate-100">${escapeHTML(displayTitle)}</span>` : ''}
        </div>

        <div class="flex items-center gap-2 self-end sm:self-auto">
          <button type="button" class="btn-edit-note bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all duration-150 active:scale-95 flex items-center gap-1.5" data-note-id="${escapeHTML(note.id)}">
            <i data-lucide="edit-3" class="w-3.5 h-3.5 text-blue-400"></i>
            Editar
          </button>
          <button type="button" class="btn-delete-note bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all duration-150 active:scale-95 flex items-center gap-1.5" data-note-id="${escapeHTML(note.id)}">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            Excluir
          </button>
        </div>
      </div>

      <div class="text-sm text-slate-200 leading-relaxed bg-slate-900/40 p-4 rounded-xl border border-slate-800/70 select-text whitespace-pre-wrap font-sans">${escapedContent}</div>
    `;

    notesListContainer.appendChild(card);
  });

  if (window.lucide) window.lucide.createIcons();
}

// Save Daily Note Handler
if (formDailyNote) {
  formDailyNote.addEventListener('submit', (e) => {
    e.preventDefault();

    const noteId = noteEditIdInput.value;
    const date = noteDateInput.value;
    const title = noteTitleInput.value.trim();
    const content = noteContentInput.value.trim();

    if (!date || !content) return;

    if (!trackerData.dailyNotes) trackerData.dailyNotes = [];

    if (noteId) {
      // Edit existing note
      const noteIndex = trackerData.dailyNotes.findIndex(n => n.id === noteId);
      if (noteIndex !== -1) {
        trackerData.dailyNotes[noteIndex] = {
          ...trackerData.dailyNotes[noteIndex],
          date,
          title,
          content,
          updatedAt: new Date().toISOString()
        };
      }
    } else {
      // Create new note
      const newNote = {
        id: 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        date,
        title,
        content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      trackerData.dailyNotes.push(newNote);
    }

    saveData();
    clearNoteForm();
    renderDailyNotes(inputSearchNotes ? inputSearchNotes.value : '');
  });
}

// Edit & Delete event delegation on notesListContainer
if (notesListContainer) {
  notesListContainer.addEventListener('click', (e) => {
    const btnEdit = e.target.closest('.btn-edit-note');
    const btnDelete = e.target.closest('.btn-delete-note');

    if (btnEdit) {
      const noteId = btnEdit.getAttribute('data-note-id');
      const note = (trackerData.dailyNotes || []).find(n => n.id === noteId);
      if (note) {
        noteEditIdInput.value = note.id;
        noteDateInput.value = note.date;
        noteTitleInput.value = note.title || '';
        noteContentInput.value = note.content || '';

        if (noteFormTitle) {
          noteFormTitle.innerHTML = `<i data-lucide="edit-3" class="w-5 h-5 text-blue-400"></i> Editar Anotação Diária`;
        }
        if (btnSaveNoteText) btnSaveNoteText.textContent = 'Atualizar Anotação';
        if (btnCancelNoteEdit) btnCancelNoteEdit.classList.remove('hidden');
        if (window.lucide) window.lucide.createIcons();

        formDailyNote.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    if (btnDelete) {
      const noteId = btnDelete.getAttribute('data-note-id');
      showConfirm('Tem certeza que deseja excluir esta anotação do dia?', () => {
        trackerData.dailyNotes = (trackerData.dailyNotes || []).filter(n => n.id !== noteId);
        saveData();
        renderDailyNotes(inputSearchNotes ? inputSearchNotes.value : '');
      });
    }
  });
}

if (btnCancelNoteEdit) {
  btnCancelNoteEdit.addEventListener('click', clearNoteForm);
}

if (inputSearchNotes) {
  inputSearchNotes.addEventListener('input', (e) => {
    renderDailyNotes(e.target.value);
  });
}

// ==========================================
// MOBILE MENU NAVIGATION LOGIC
// ==========================================

function closeMobileMenu() {
  const headerActions = document.getElementById('header-actions');
  const mobileMenuIcon = document.getElementById('mobile-menu-icon');
  const mobileMenuText = document.getElementById('mobile-menu-text');
  if (headerActions && !headerActions.classList.contains('hidden')) {
    headerActions.classList.add('hidden');
  }
  if (mobileMenuIcon) {
    mobileMenuIcon.innerHTML = `<i data-lucide="menu" class="w-5 h-5"></i>`;
    if (window.lucide) window.lucide.createIcons({ root: mobileMenuIcon });
  }
  if (mobileMenuText) {
    mobileMenuText.textContent = 'Menu';
  }
}

function openMobileMenu() {
  const headerActions = document.getElementById('header-actions');
  const mobileMenuIcon = document.getElementById('mobile-menu-icon');
  const mobileMenuText = document.getElementById('mobile-menu-text');
  if (headerActions) {
    headerActions.classList.remove('hidden');
  }
  if (mobileMenuIcon) {
    mobileMenuIcon.innerHTML = `<i data-lucide="x" class="w-5 h-5 text-rose-400"></i>`;
    if (window.lucide) window.lucide.createIcons({ root: mobileMenuIcon });
  }
  if (mobileMenuText) {
    mobileMenuText.textContent = 'Fechar';
  }
}

function toggleMobileMenu() {
  const headerActions = document.getElementById('header-actions');
  if (headerActions) {
    if (headerActions.classList.contains('hidden')) {
      openMobileMenu();
    } else {
      closeMobileMenu();
    }
  }
}

// ==========================================
// SUPABASE AUTHENTICATION MODULE (LOGIN & REGISTRO)
// ==========================================

let currentSession = null;
let currentAuthMode = 'login'; // 'login' ou 'register'

function getProfileName(user) {
  const metadata = user?.user_metadata || {};
  const name = metadata.full_name || metadata.name || metadata.display_name;
  if (name && String(name).trim()) return String(name).trim();
  const email = user?.email || '';
  return email ? email.split('@')[0] : 'Usuário';
}

function populateProfile(user = currentSession?.user) {
  const name = getProfileName(user);
  const email = user?.email || '';
  const headerName = document.getElementById('user-name-display');
  const headerEmail = document.getElementById('user-email-display');
  const profileName = document.getElementById('profile-name-display');
  const profileEmail = document.getElementById('profile-email-display');
  const profileNameInput = document.getElementById('profile-name-input');

  if (headerName) headerName.textContent = name;
  if (headerEmail) headerEmail.textContent = email;
  if (profileName) profileName.textContent = name;
  if (profileEmail) profileEmail.textContent = email;
  if (profileNameInput && document.activeElement !== profileNameInput) profileNameInput.value = name;
}

function showProfilePasswordAlert(message, type = 'error') {
  const alert = document.getElementById('profile-password-alert');
  if (!alert) return;
  alert.textContent = message;
  alert.className = `text-xs rounded-xl border px-3 py-2.5 ${type === 'success'
    ? 'bg-emerald-950/50 border-emerald-500/30 text-emerald-300'
    : 'bg-rose-950/50 border-rose-500/30 text-rose-300'}`;
}

function openProfileModal() {
  const modal = document.getElementById('modal-profile');
  if (!modal) return;
  closeMobileMenu();
  populateProfile();
  const form = document.getElementById('form-change-password');
  if (form) form.reset();
  const alert = document.getElementById('profile-password-alert');
  if (alert) alert.classList.add('hidden');
  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons({ root: modal });
}

function closeProfileModal() {
  const modal = document.getElementById('modal-profile');
  if (modal) modal.classList.add('hidden');
}

async function handleProfileNameUpdate(event) {
  event.preventDefault();
  const input = document.getElementById('profile-name-input');
  const button = document.getElementById('btn-save-profile-name');
  const name = input?.value.trim() || '';
  if (!name) {
    if (input) input.focus();
    return;
  }
  if (!supabaseClient || !currentSession?.user) return;

  if (button) {
    button.disabled = true;
    button.textContent = 'Salvando...';
  }
  try {
    const { data, error } = await supabaseClient.auth.updateUser({
      data: { ...(currentSession.user.user_metadata || {}), full_name: name }
    });
    if (error) throw error;
    if (data?.user && currentSession) {
      currentSession = { ...currentSession, user: data.user };
      populateProfile(data.user);
    }
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    showProfilePasswordAlert(translateAuthError(error));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Salvar';
    }
  }
}

async function handleChangePassword(event) {
  event.preventDefault();
  const currentInput = document.getElementById('profile-current-password');
  const newInput = document.getElementById('profile-new-password');
  const confirmInput = document.getElementById('profile-confirm-password');
  const submitButton = document.getElementById('btn-change-password');
  const currentPassword = currentInput?.value || '';
  const newPassword = newInput?.value || '';
  const confirmation = confirmInput?.value || '';

  if (!currentPassword || !newPassword || !confirmation) {
    showProfilePasswordAlert('Preencha todos os campos de senha.');
    return;
  }
  if (newPassword.length < 8) {
    showProfilePasswordAlert('A nova senha precisa ter no mínimo 8 caracteres.');
    return;
  }
  if (newPassword !== confirmation) {
    showProfilePasswordAlert('A confirmação não coincide com a nova senha.');
    return;
  }
  if (!supabaseClient || !currentSession?.user) {
    showProfilePasswordAlert('Sua sessão não está disponível. Entre novamente para alterar a senha.');
    return;
  }

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Salvando...';
  }

  try {
    const { data, error } = await supabaseClient.auth.updateUser({
      password: newPassword,
      current_password: currentPassword
    });
    if (error) throw error;

    if (data?.user && currentSession) {
      currentSession = { ...currentSession, user: data.user };
      populateProfile(data.user);
    }
    if (currentInput) currentInput.value = '';
    if (newInput) newInput.value = '';
    if (confirmInput) confirmInput.value = '';
    showProfilePasswordAlert('Senha alterada com sucesso.', 'success');
  } catch (error) {
    console.error('Erro ao alterar senha:', error);
    showProfilePasswordAlert(translateAuthError(error));
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Salvar nova senha';
    }
  }
}

function switchAuthMode(mode) {
  currentAuthMode = mode;

  const tabLogin = document.getElementById('auth-tab-login');
  const tabRegister = document.getElementById('auth-tab-register');
  const btnText = document.getElementById('auth-btn-text');
  const togglePrompt = document.getElementById('auth-toggle-prompt');
  const btnToggleMode = document.getElementById('btn-auth-toggle-mode');
  const passwordHint = document.getElementById('auth-password-hint');
  const btnForgotPassword = document.getElementById('btn-forgot-password');

  hideAuthAlert();

  if (mode === 'login') {
    if (tabLogin) {
      tabLogin.className = 'py-2.5 text-xs sm:text-sm font-bold rounded-xl transition-all duration-200 bg-blue-600 text-white shadow-sm';
    }
    if (tabRegister) {
      tabRegister.className = 'py-2.5 text-xs sm:text-sm font-semibold rounded-xl transition-all duration-200 text-slate-400 hover:text-slate-200';
    }
    if (btnText) btnText.textContent = 'Entrar na Conta';
    if (togglePrompt) togglePrompt.textContent = 'Não tem uma conta?';
    if (btnToggleMode) btnToggleMode.textContent = 'Criar Conta';
    if (passwordHint) passwordHint.classList.add('hidden');
    if (btnForgotPassword) btnForgotPassword.classList.remove('hidden');
  } else {
    if (tabRegister) {
      tabRegister.className = 'py-2.5 text-xs sm:text-sm font-bold rounded-xl transition-all duration-200 bg-blue-600 text-white shadow-sm';
    }
    if (tabLogin) {
      tabLogin.className = 'py-2.5 text-xs sm:text-sm font-semibold rounded-xl transition-all duration-200 text-slate-400 hover:text-slate-200';
    }
    if (btnText) btnText.textContent = 'Criar Nova Conta';
    if (togglePrompt) togglePrompt.textContent = 'Já possui uma conta?';
    if (btnToggleMode) btnToggleMode.textContent = 'Fazer Login';
    if (passwordHint) passwordHint.classList.remove('hidden');
    if (btnForgotPassword) btnForgotPassword.classList.add('hidden');
  }
}

function showAuthAlert(message, type = 'error') {
  const alertContainer = document.getElementById('auth-alert');
  const alertIcon = document.getElementById('auth-alert-icon');
  const alertMsg = document.getElementById('auth-alert-msg');
  if (!alertContainer || !alertMsg) return;

  alertContainer.classList.remove('hidden');
  alertMsg.textContent = message;

  if (type === 'error') {
    alertContainer.className = 'mb-5 p-3.5 rounded-xl text-xs flex items-start gap-2.5 border transition-all bg-rose-950/50 border-rose-500/30 text-rose-300';
    if (alertIcon) {
      alertIcon.setAttribute('data-lucide', 'alert-circle');
      alertIcon.className = 'w-4 h-4 mt-0.5 shrink-0 text-rose-400';
    }
  } else if (type === 'success') {
    alertContainer.className = 'mb-5 p-3.5 rounded-xl text-xs flex items-start gap-2.5 border transition-all bg-emerald-950/50 border-emerald-500/30 text-emerald-300';
    if (alertIcon) {
      alertIcon.setAttribute('data-lucide', 'check-circle-2');
      alertIcon.className = 'w-4 h-4 mt-0.5 shrink-0 text-emerald-400';
    }
  } else {
    alertContainer.className = 'mb-5 p-3.5 rounded-xl text-xs flex items-start gap-2.5 border transition-all bg-blue-950/50 border-blue-500/30 text-blue-300';
    if (alertIcon) {
      alertIcon.setAttribute('data-lucide', 'info');
      alertIcon.className = 'w-4 h-4 mt-0.5 shrink-0 text-blue-400';
    }
  }

  if (window.lucide) {
    window.lucide.createIcons({ root: alertContainer });
  }
}

function hideAuthAlert() {
  const alertContainer = document.getElementById('auth-alert');
  if (alertContainer) alertContainer.classList.add('hidden');
}

function setAuthLoading(isLoading) {
  const btnSubmit = document.getElementById('btn-auth-submit');
  const spinner = document.getElementById('auth-btn-spinner');
  const emailInput = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');

  if (btnSubmit) btnSubmit.disabled = isLoading;
  if (emailInput) emailInput.disabled = isLoading;
  if (passwordInput) passwordInput.disabled = isLoading;

  if (spinner) {
    if (isLoading) {
      spinner.classList.remove('hidden');
    } else {
      spinner.classList.add('hidden');
    }
  }
}

function translateAuthError(error) {
  if (!error) return 'Ocorreu um erro inesperado.';
  const msg = error.message || error.toString();

  if (msg.includes('Invalid login credentials')) {
    return 'E-mail ou senha incorretos. Verifique seus dados e tente novamente.';
  }
  if (msg.includes('Email not confirmed')) {
    return 'E-mail ainda não confirmado. Verifique a caixa de entrada do seu e-mail.';
  }
  if (msg.includes('User already registered') || msg.includes('user_already_exists')) {
    return 'Este e-mail já está cadastrado. Alterne para a aba "Entrar" e faça login.';
  }
  if (msg.includes('Password should be at least') || msg.includes('at least 6 characters') || msg.includes('at least 8 characters')) {
    return 'A senha precisa ter no mínimo 8 caracteres.';
  }
  if (msg.toLowerCase().includes('invalid password') || msg.toLowerCase().includes('current password')) {
    return 'A senha atual está incorreta.';
  }
  if (msg.includes('Unable to validate email address') || msg.includes('invalid format') || msg.includes('invalid email')) {
    return 'Por favor, insira um endereço de e-mail válido.';
  }
  if (msg.includes('Signup requires a valid password')) {
    return 'A senha informada é inválida.';
  }
  if (msg.includes('For security purposes') || msg.includes('once every')) {
    return 'Por segurança, aguarde alguns instantes antes de solicitar um novo e-mail de recuperação.';
  }
  if (msg.includes('Email rate limit exceeded')) {
    return 'Limite de envio de e-mails atingido temporariamente. Aguarde alguns minutos e tente novamente.';
  }
  if (msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('invalid token')) {
    return 'O link de recuperação expirou ou é inválido. Por favor, solicite um novo link.';
  }
  if (msg.includes('New password should be different')) {
    return 'A nova senha deve ser diferente da senha anterior.';
  }

  return msg;
}

// ==========================================
// PASSWORD RECOVERY & RESET FLOW (SUPABASE)
// ==========================================

let isPasswordRecoveryMode = false;

function openForgotPasswordModal() {
  const modal = document.getElementById('modal-forgot-password');
  const authEmailInput = document.getElementById('auth-email');
  const forgotEmailInput = document.getElementById('forgot-email');
  hideForgotAlert();

  if (forgotEmailInput && authEmailInput && authEmailInput.value.trim()) {
    forgotEmailInput.value = authEmailInput.value.trim();
  }

  if (modal) {
    modal.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons({ root: modal });
  }

  setTimeout(() => {
    if (forgotEmailInput) forgotEmailInput.focus();
  }, 100);
}

function closeForgotPasswordModal() {
  const modal = document.getElementById('modal-forgot-password');
  if (modal) modal.classList.add('hidden');
  hideForgotAlert();
  setForgotLoading(false);
}

function showForgotAlert(message, type = 'error') {
  const alertContainer = document.getElementById('forgot-alert');
  const alertIcon = document.getElementById('forgot-alert-icon');
  const alertMsg = document.getElementById('forgot-alert-msg');
  if (!alertContainer || !alertMsg) return;

  alertContainer.classList.remove('hidden');
  alertMsg.textContent = message;

  if (type === 'error') {
    alertContainer.className = 'mb-4 p-3.5 rounded-xl text-xs flex items-start gap-2.5 border transition-all bg-rose-950/50 border-rose-500/30 text-rose-300';
    if (alertIcon) {
      alertIcon.setAttribute('data-lucide', 'alert-circle');
      alertIcon.className = 'w-4 h-4 mt-0.5 shrink-0 text-rose-400';
    }
  } else if (type === 'success') {
    alertContainer.className = 'mb-4 p-3.5 rounded-xl text-xs flex items-start gap-2.5 border transition-all bg-emerald-950/50 border-emerald-500/30 text-emerald-300';
    if (alertIcon) {
      alertIcon.setAttribute('data-lucide', 'check-circle-2');
      alertIcon.className = 'w-4 h-4 mt-0.5 shrink-0 text-emerald-400';
    }
  } else {
    alertContainer.className = 'mb-4 p-3.5 rounded-xl text-xs flex items-start gap-2.5 border transition-all bg-blue-950/50 border-blue-500/30 text-blue-300';
    if (alertIcon) {
      alertIcon.setAttribute('data-lucide', 'info');
      alertIcon.className = 'w-4 h-4 mt-0.5 shrink-0 text-blue-400';
    }
  }

  if (window.lucide) {
    window.lucide.createIcons({ root: alertContainer });
  }
}

function hideForgotAlert() {
  const alertContainer = document.getElementById('forgot-alert');
  if (alertContainer) alertContainer.classList.add('hidden');
}

function setForgotLoading(isLoading) {
  const btnSubmit = document.getElementById('btn-submit-forgot');
  const spinner = document.getElementById('forgot-btn-spinner');
  const btnText = document.getElementById('forgot-btn-text');
  const emailInput = document.getElementById('forgot-email');

  if (btnSubmit) btnSubmit.disabled = isLoading;
  if (emailInput) emailInput.disabled = isLoading;
  if (spinner) {
    if (isLoading) spinner.classList.remove('hidden');
    else spinner.classList.add('hidden');
  }
  if (btnText) {
    btnText.textContent = isLoading ? 'Enviando link...' : 'Enviar Link';
  }
}

async function handleForgotPasswordSubmit(e) {
  e.preventDefault();
  if (!supabaseClient) {
    showForgotAlert('Supabase não inicializado. Verifique suas credenciais em config.js.', 'error');
    return;
  }

  const emailInput = document.getElementById('forgot-email');
  const email = emailInput ? emailInput.value.trim() : '';

  if (!email) {
    showForgotAlert('Por favor, informe seu e-mail cadastrado.', 'error');
    return;
  }

  setForgotLoading(true);
  hideForgotAlert();

  try {
    // Redireciona de volta para a mesma página com o token seguro
    const redirectTo = window.location.origin + window.location.pathname;

    const { data, error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo
    });

    if (error) {
      showForgotAlert(translateAuthError(error), 'error');
    } else {
      showForgotAlert('Link de recuperação enviado com sucesso! Verifique a sua caixa de entrada e spam.', 'success');
      if (emailInput) emailInput.value = '';
    }
  } catch (err) {
    console.error('Erro ao solicitar recuperação de senha:', err);
    showForgotAlert('Falha de conexão com o Supabase. Tente novamente.', 'error');
  } finally {
    setForgotLoading(false);
  }
}

function openResetPasswordModal() {
  isPasswordRecoveryMode = true;
  const modal = document.getElementById('modal-reset-password');
  const newPass = document.getElementById('reset-new-password');
  const confirmPass = document.getElementById('reset-confirm-password');

  if (newPass) newPass.value = '';
  if (confirmPass) confirmPass.value = '';
  hideResetAlert();

  if (modal) {
    modal.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons({ root: modal });
  }

  setTimeout(() => {
    if (newPass) newPass.focus();
  }, 100);
}

function closeResetPasswordModal() {
  isPasswordRecoveryMode = false;
  const modal = document.getElementById('modal-reset-password');
  if (modal) modal.classList.add('hidden');
  hideResetAlert();
  setResetLoading(false);

  // Limpa o hash da URL
  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

function showResetAlert(message, type = 'error') {
  const alertContainer = document.getElementById('reset-alert');
  const alertIcon = document.getElementById('reset-alert-icon');
  const alertMsg = document.getElementById('reset-alert-msg');
  if (!alertContainer || !alertMsg) return;

  alertContainer.classList.remove('hidden');
  alertMsg.textContent = message;

  if (type === 'error') {
    alertContainer.className = 'mb-4 p-3.5 rounded-xl text-xs flex items-start gap-2.5 border transition-all bg-rose-950/50 border-rose-500/30 text-rose-300';
    if (alertIcon) {
      alertIcon.setAttribute('data-lucide', 'alert-circle');
      alertIcon.className = 'w-4 h-4 mt-0.5 shrink-0 text-rose-400';
    }
  } else if (type === 'success') {
    alertContainer.className = 'mb-4 p-3.5 rounded-xl text-xs flex items-start gap-2.5 border transition-all bg-emerald-950/50 border-emerald-500/30 text-emerald-300';
    if (alertIcon) {
      alertIcon.setAttribute('data-lucide', 'check-circle-2');
      alertIcon.className = 'w-4 h-4 mt-0.5 shrink-0 text-emerald-400';
    }
  } else {
    alertContainer.className = 'mb-4 p-3.5 rounded-xl text-xs flex items-start gap-2.5 border transition-all bg-blue-950/50 border-blue-500/30 text-blue-300';
    if (alertIcon) {
      alertIcon.setAttribute('data-lucide', 'info');
      alertIcon.className = 'w-4 h-4 mt-0.5 shrink-0 text-blue-400';
    }
  }

  if (window.lucide) {
    window.lucide.createIcons({ root: alertContainer });
  }
}

function hideResetAlert() {
  const alertContainer = document.getElementById('reset-alert');
  if (alertContainer) alertContainer.classList.add('hidden');
}

function setResetLoading(isLoading) {
  const btnSubmit = document.getElementById('btn-submit-reset');
  const spinner = document.getElementById('reset-btn-spinner');
  const btnText = document.getElementById('reset-btn-text');
  const newPass = document.getElementById('reset-new-password');
  const confirmPass = document.getElementById('reset-confirm-password');

  if (btnSubmit) btnSubmit.disabled = isLoading;
  if (newPass) newPass.disabled = isLoading;
  if (confirmPass) confirmPass.disabled = isLoading;
  if (spinner) {
    if (isLoading) spinner.classList.remove('hidden');
    else spinner.classList.add('hidden');
  }
  if (btnText) {
    btnText.textContent = isLoading ? 'Salvando nova senha...' : 'Salvar Nova Senha';
  }
}

async function handleResetPasswordSubmit(e) {
  e.preventDefault();
  if (!supabaseClient) {
    showResetAlert('Supabase não inicializado.', 'error');
    return;
  }

  const newPassInput = document.getElementById('reset-new-password');
  const confirmPassInput = document.getElementById('reset-confirm-password');
  const newPassword = newPassInput ? newPassInput.value : '';
  const confirmPassword = confirmPassInput ? confirmPassInput.value : '';

  if (!newPassword || !confirmPassword) {
    showResetAlert('Preencha os dois campos de senha.', 'error');
    return;
  }

  if (newPassword.length < 8) {
    showResetAlert('A senha deve conter pelo menos 8 caracteres.', 'error');
    return;
  }

  if (newPassword !== confirmPassword) {
    showResetAlert('As duas senhas informadas não coincidem.', 'error');
    return;
  }

  setResetLoading(true);
  hideResetAlert();

  try {
    const { data, error } = await supabaseClient.auth.updateUser({
      password: newPassword
    });

    if (error) {
      showResetAlert(translateAuthError(error), 'error');
    } else {
      showResetAlert('Senha atualizada com sucesso! Acessando sua conta...', 'success');

      if (newPassInput) newPassInput.value = '';
      if (confirmPassInput) confirmPassInput.value = '';

      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }

      setTimeout(async () => {
        closeResetPasswordModal();
        try {
          const { data: { session } } = await supabaseClient.auth.getSession();
          await updateAppForSession(session);
        } catch (_) {
          window.location.reload();
        }
      }, 1500);
    }
  } catch (err) {
    console.error('Erro ao redefinir senha:', err);
    showResetAlert('Ocorreu uma falha ao redefinir sua senha. Tente novamente.', 'error');
  } finally {
    setResetLoading(false);
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  if (!supabaseClient) {
    showAuthAlert('SDK do Supabase não foi inicializado corretamente.', 'error');
    return;
  }

  const emailInput = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');

  const email = emailInput ? emailInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (!email || !password) {
    showAuthAlert('Preencha todos os campos obrigatórios.', 'error');
    return;
  }

  if (password.length < 8) {
    showAuthAlert('A senha deve conter no mínimo 8 caracteres.', 'error');
    return;
  }

  setAuthLoading(true);
  hideAuthAlert();

  try {
    if (currentAuthMode === 'login') {
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        showAuthAlert(translateAuthError(error), 'error');
      } else if (data && data.session) {
        showAuthAlert('Login realizado com sucesso! Redirecionando...', 'success');
        await updateAppForSession(data.session);
      }
    } else {
      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password
      });

      if (error) {
        showAuthAlert(translateAuthError(error), 'error');
      } else {
        if (data && data.session) {
          showAuthAlert('Conta criada e logada com sucesso! Bem-vindo.', 'success');
          await updateAppForSession(data.session);
        } else if (data && data.user) {
          showAuthAlert('Conta criada com sucesso! Se necessário, confirme seu e-mail antes de fazer login.', 'info');
          switchAuthMode('login');
          if (emailInput) emailInput.value = email;
          if (passwordInput) passwordInput.value = '';
        }
      }
    }
  } catch (err) {
    console.error('Erro de autenticação:', err);
    showAuthAlert('Ocorreu uma falha de conexão. Tente novamente.', 'error');
  } finally {
    setAuthLoading(false);
  }
}

async function handleLogout() {
  if (supabaseClient) {
    try {
      showSyncIndicator('loading', 'Saindo...');
      await supabaseClient.auth.signOut();
    } catch (e) {
      console.error('Erro ao fazer logout:', e);
    }
  }
  trackerData = { days: [], dailyNotes: [], goal: { amount: 0, startDate: '' } };
  globalBalance = 0;
  balanceHistory = [];
  updateAppForSession(null);
}

let appLoaded = false;
async function updateAppForSession(session) {
  currentSession = session;
  const authContainer = document.getElementById('auth-container');
  const appContainer = document.getElementById('app-container');
  const userBadge = document.getElementById('user-badge');

  if (session && session.user) {
    // Se o usuário está redefinindo a senha vindo pelo link do e-mail, aguarda concluir
    if (isPasswordRecoveryMode) {
      return;
    }

    // Exibe a aplicação e esconde o login
    if (authContainer) authContainer.classList.add('hidden');
    if (appContainer) appContainer.classList.remove('hidden');

    populateProfile(session.user);
    if (userBadge) {
      userBadge.classList.remove('hidden');
      userBadge.classList.add('flex');
    }

    if (window.lucide) window.lucide.createIcons();

    // Carrega os dados se ainda não tiver carregado nesta sessão
    if (!appLoaded) {
      appLoaded = true;
      await loadData();
      initRealtimeSync();
      renderAllDays();
      updateGlobalCapital();
      setDefaultNoteDate();
      initBetTrackerCalculator();
      handleHashNavigation();
    }
  } else {
    // Esconde a aplicação e mostra a tela de login
    appLoaded = false;
    if (appContainer) appContainer.classList.add('hidden');
    if (authContainer) authContainer.classList.remove('hidden');
    if (userBadge) {
      userBadge.classList.add('hidden');
      userBadge.classList.remove('flex');
    }

    if (window.lucide) window.lucide.createIcons();
  }
}

async function initAuthFlow() {
  const authForm = document.getElementById('auth-form');
  const tabLogin = document.getElementById('auth-tab-login');
  const tabRegister = document.getElementById('auth-tab-register');
  const btnToggleMode = document.getElementById('btn-auth-toggle-mode');
  const btnTogglePassword = document.getElementById('btn-toggle-password');
  const btnLogout = document.getElementById('btn-logout');
  const btnOpenProfile = document.getElementById('user-badge');
  const btnCloseProfile = document.getElementById('modal-profile-close');
  const profileNameForm = document.getElementById('form-profile-name');
  const changePasswordForm = document.getElementById('form-change-password');

  // Esqueci minha senha e Redefinição
  const btnForgotPassword = document.getElementById('btn-forgot-password');
  const btnModalForgotClose = document.getElementById('modal-forgot-close');
  const btnCancelForgot = document.getElementById('btn-cancel-forgot');
  const formForgotPassword = document.getElementById('form-forgot-password');
  const btnToggleResetPass = document.getElementById('btn-toggle-reset-password');
  const btnCancelReset = document.getElementById('btn-cancel-reset');
  const formResetPassword = document.getElementById('form-reset-password');

  if (tabLogin) tabLogin.addEventListener('click', () => switchAuthMode('login'));
  if (tabRegister) tabRegister.addEventListener('click', () => switchAuthMode('register'));
  if (btnToggleMode) {
    btnToggleMode.addEventListener('click', () => {
      switchAuthMode(currentAuthMode === 'login' ? 'register' : 'login');
    });
  }

  if (btnTogglePassword) {
    btnTogglePassword.addEventListener('click', () => {
      const passwordInput = document.getElementById('auth-password');
      if (!passwordInput) return;
      const isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
      btnTogglePassword.innerHTML = `<i data-lucide="${isPassword ? 'eye-off' : 'eye'}" class="w-4 h-4"></i>`;
      if (window.lucide) window.lucide.createIcons({ root: btnTogglePassword });
    });
  }

  if (authForm) {
    authForm.addEventListener('submit', handleAuthSubmit);
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', handleLogout);
  }
  if (btnOpenProfile) btnOpenProfile.addEventListener('click', openProfileModal);
  if (btnCloseProfile) btnCloseProfile.addEventListener('click', closeProfileModal);
  if (profileNameForm) profileNameForm.addEventListener('submit', handleProfileNameUpdate);
  if (changePasswordForm) changePasswordForm.addEventListener('submit', handleChangePassword);

  // Listeners para Esqueci Minha Senha
  if (btnForgotPassword) btnForgotPassword.addEventListener('click', openForgotPasswordModal);
  if (btnModalForgotClose) btnModalForgotClose.addEventListener('click', closeForgotPasswordModal);
  if (btnCancelForgot) btnCancelForgot.addEventListener('click', closeForgotPasswordModal);
  if (formForgotPassword) formForgotPassword.addEventListener('submit', handleForgotPasswordSubmit);

  // Listeners para Redefinição de Nova Senha
  if (btnToggleResetPass) {
    btnToggleResetPass.addEventListener('click', () => {
      const input = document.getElementById('reset-new-password');
      if (!input) return;
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      btnToggleResetPass.innerHTML = `<i data-lucide="${isPass ? 'eye-off' : 'eye'}" class="w-4 h-4"></i>`;
      if (window.lucide) window.lucide.createIcons({ root: btnToggleResetPass });
    });
  }

  if (btnCancelReset) {
    btnCancelReset.addEventListener('click', async () => {
      closeResetPasswordModal();
      if (supabaseClient) {
        try {
          await supabaseClient.auth.signOut();
        } catch (_) {}
      }
      updateAppForSession(null);
    });
  }

  if (formResetPassword) {
    formResetPassword.addEventListener('submit', handleResetPasswordSubmit);
  }

  // Verificar sessão atual
  if (!supabaseClient) {
    console.warn('Supabase não disponível.');
    updateAppForSession(null);
    return;
  }

  try {
    // Detecta se a página foi aberta com parâmetros de recuperação de senha no hash (#type=recovery ou access_token)
    const initialHash = window.location.hash;
    if (initialHash && (initialHash.includes('type=recovery') || initialHash.includes('access_token='))) {
      isPasswordRecoveryMode = true;
      setTimeout(() => {
        openResetPasswordModal();
      }, 300);
    } else if (initialHash && (initialHash.includes('error=') || initialHash.includes('error_code='))) {
      // Captura erros de link expirado ou já utilizado vindos pelo e-mail do Supabase
      setTimeout(() => {
        if (initialHash.includes('otp_expired') || initialHash.includes('expired')) {
          showAuthAlert('O link de recuperação de senha expirou ou já foi utilizado. Solicite um novo link clicando em "Esqueceu a senha?".', 'error');
        } else {
          showAuthAlert('O link de acesso é inválido ou expirou. Por favor, tente novamente.', 'error');
        }
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }
      }, 300);
    }

    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!isPasswordRecoveryMode) {
      await updateAppForSession(session);
    }

    // Escutar eventos de sessão (SIGN_IN, SIGN_OUT, TOKEN_REFRESHED, PASSWORD_RECOVERY)
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      console.log('Evento Supabase Auth:', event);
      if (event === 'PASSWORD_RECOVERY') {
        openResetPasswordModal();
        return;
      }
      if (isPasswordRecoveryMode) {
        return;
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        await updateAppForSession(session);
      } else if (event === 'SIGNED_OUT') {
        await updateAppForSession(null);
      }
    });
  } catch (err) {
    console.error('Erro ao verificar sessão Supabase:', err);
    updateAppForSession(null);
  }
}

// ==========================================
// APP START
// ==========================================

window.addEventListener('DOMContentLoaded', async () => {
  // Inicializa o fluxo de autenticação e sessão
  await initAuthFlow();

  // Menu Mobile Listener
  const btnMobileMenuToggle = document.getElementById('btn-mobile-menu-toggle');
  if (btnMobileMenuToggle) {
    btnMobileMenuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMobileMenu();
    });
  }
});

