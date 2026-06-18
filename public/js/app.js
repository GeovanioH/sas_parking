/* SAS Parking v2.0 — JavaScript principal */

// ─── Menu mobile ────────────────────────
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const isDesktop = window.innerWidth >= 769;
  if (isDesktop) {
    sidebar?.classList.toggle('collapsed');
    localStorage.setItem('sidebarCollapsed', sidebar?.classList.contains('collapsed'));
  } else {
    sidebar?.classList.toggle('open');
  }
}
// Restaurer l'état au chargement
document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('sidebarCollapsed') === 'true' && window.innerWidth >= 769) {
    document.getElementById('sidebar')?.classList.add('collapsed');
  }
});

// ─── Fermer sidebar au clic overlay ─────
document.addEventListener('click', function(e) {
  const sidebar = document.getElementById('sidebar');
  const toggle  = document.querySelector('.menu-toggle');
  if (sidebar && sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target !== toggle) {
    sidebar.classList.remove('open');
  }
});

// ─── Copier le code HEX au clic ─────────
document.addEventListener('click', function(e) {
  const el = e.target.closest('.code-hex-display');
  if (!el) return;
  const text = el.textContent.trim();
  navigator.clipboard?.writeText(text).then(() => {
    const orig = el.textContent;
    el.textContent = '✓ Copié !';
    setTimeout(() => { el.textContent = orig; }, 1500);
  });
});

// ─── Clavier numérique (page entrée) ────
window.initKeypad = function() {
  const input = document.getElementById('plaqueInput');
  if (!input) return;

  document.querySelectorAll('.key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.key;
      if (val === 'DEL') {
        input.value = input.value.slice(0, -1);
      } else {
        if (input.value.length < 12) input.value += val;
      }
      input.dispatchEvent(new Event('input'));
    });
  });

  // Valider sur Entrée
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const form = input.closest('form');
      if (form) form.requestSubmit?.() || form.submit();
    }
  });
};

// ─── Payment options ─────────────────────
window.selectPayment = function(mode) {
  document.querySelectorAll('.payment-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.mode === mode);
  });
  const hidden = document.getElementById('modeInput');
  if (hidden) hidden.value = mode;
};

// ─── Modals ───────────────────────────────
window.openModal = function(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.remove('hidden'); m.style.display = 'flex'; }
};
window.closeModal = function(id) {
  const m = document.getElementById(id);
  if (m) { m.style.display = 'none'; }
};

// Fermer modal en cliquant overlay
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.style.display = 'none';
  }
});
// Fermer avec Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay').forEach(m => { m.style.display = 'none'; });
  }
});

// ─── Dismiss alerts ──────────────────────
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-dismiss="alert"]');
  if (btn) btn.closest('.alert')?.remove();
});

// ─── Auto-dismiss flash messages ─────────
setTimeout(() => {
  document.querySelectorAll('.alert-auto-dismiss').forEach(a => {
    a.style.transition = 'opacity .5s';
    a.style.opacity = '0';
    setTimeout(() => a.remove(), 500);
  });
}, 4000);

// ─── Confirmation avant suppression ─────
document.querySelectorAll('[data-confirm]').forEach(btn => {
  btn.addEventListener('click', e => {
    if (!confirm(btn.dataset.confirm || 'Confirmer cette action ?')) {
      e.preventDefault();
    }
  });
});

// ─── Clock en temps réel ─────────────────
function updateClock() {
  const el = document.getElementById('liveClock');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
setInterval(updateClock, 1000);
updateClock();

// ─── Timer durée de garde ─────────────────
document.querySelectorAll('[data-entree]').forEach(el => {
  function tick() {
    const entree  = new Date(el.dataset.entree);
    const now     = new Date();
    const diffMs  = now - entree;
    const h  = Math.floor(diffMs / 3600000);
    const m  = Math.floor((diffMs % 3600000) / 60000);
    const s  = Math.floor((diffMs % 60000) / 1000);
    el.textContent = `${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
  }
  tick();
  setInterval(tick, 1000);
});

// ─── Graphique recettes (Chart.js) ───────
window.initRevenueChart = function(canvasId, data) {
  if (typeof Chart === 'undefined') return;
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;

  const labels = data.map(d => `${String(d.heure).padStart(2,'0')}h`);
  const values = data.map(d => d.total);

  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Recettes (FCFA)',
        data: values,
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,.12)',
        borderWidth: 2.5,
        pointBackgroundColor: '#22c55e',
        pointRadius: 4,
        pointHoverRadius: 6,
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.parsed.y.toLocaleString('fr-FR')} FCFA`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: {
          grid: { color: '#f3f4f6' },
          ticks: {
            font: { size: 11 },
            callback: v => v.toLocaleString('fr-FR')
          }
        }
      }
    }
  });
};

// ─── Graphique donut paiements ────────────
window.initDonutChart = function(canvasId, mobile, especes) {
  if (typeof Chart === 'undefined') return;
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Mobile Money', 'Espèces'],
      datasets: [{
        data: [mobile, especes],
        backgroundColor: ['#22c55e', '#94a3b8'],
        borderWidth: 0,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { size: 12 }, padding: 16 }
        },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.label} : ${ctx.parsed}%`
          }
        }
      },
      cutout: '65%'
    }
  });
};

// ─── Graphique barres rapports ────────────
window.initBarChart = function(canvasId, data) {
  if (typeof Chart === 'undefined') return;
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => {
        const d2 = new Date(d.jour);
        return `${d2.getDate()}/${d2.getMonth()+1}`;
      }),
      datasets: [{
        label: 'Recettes',
        data: data.map(d => Number(d.total)),
        backgroundColor: '#22c55e',
        borderRadius: 6,
        hoverBackgroundColor: '#15803d'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `${ctx.parsed.y.toLocaleString('fr-FR')} FCFA` } }
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          grid: { color: '#f3f4f6' },
          ticks: { callback: v => v.toLocaleString('fr-FR') }
        }
      }
    }
  });
};

// ─── Init au chargement ───────────────────
document.addEventListener('DOMContentLoaded', () => {
  initKeypad?.();
});
