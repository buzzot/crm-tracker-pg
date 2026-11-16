document.addEventListener('DOMContentLoaded', () => {
  initPipelineDragDrop();
  initStageDropdowns();
  initActivityModal();
  initCompanySearch();
  initTooltips();
});

function initTooltips() {
  document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
    new bootstrap.Tooltip(el);
  });
}

async function patchDealStage(dealId, stage) {
  const res = await fetch(`/pipeline/api/deals/${dealId}/stage`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Update failed');
  return data.deal;
}

function initPipelineDragDrop() {
  const cards = document.querySelectorAll('.deal-card');
  const cols = document.querySelectorAll('.pipeline-col-body');
  if (!cards.length || !cols.length) return;

  cards.forEach((card) => {
    card.addEventListener('dragstart', () => {
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });
  });

  cols.forEach((col) => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const dragging = document.querySelector('.deal-card.dragging');
      if (!dragging) return;

      const newStage = col.dataset.stage;
      const dealId = dragging.dataset.dealId;
      const originalParent = dragging.parentElement;

      col.appendChild(dragging);
      const select = dragging.querySelector('.stage-select');
      if (select) select.value = newStage;

      try {
        await patchDealStage(dealId, newStage);
      } catch (err) {
        alert('Could not update stage: ' + err.message);
        originalParent.appendChild(dragging);
        if (select) select.value = originalParent.dataset.stage;
      }
    });
  });
}

function initStageDropdowns() {
  document.querySelectorAll('.stage-select').forEach((select) => {
    select.addEventListener('change', async () => {
      const dealId = select.dataset.dealId;
      const newStage = select.value;
      const card = select.closest('.deal-card');
      const targetCol = document.querySelector(`.pipeline-col-body[data-stage="${newStage}"]`);

      try {
        await patchDealStage(dealId, newStage);
        if (targetCol && card) targetCol.appendChild(card);
      } catch (err) {
        alert('Could not update stage: ' + err.message);
      }
    });
  });
}

function apiBase(kind, id) {
  return kind === 'project-activity' ? `/api/project-activities/${id}` : `/api/activities/${id}`;
}

function initActivityModal() {
  const links = document.querySelectorAll('.activity-link');
  if (!links.length) return;

  const modalEl = document.getElementById('activityModal');
  const modal = new bootstrap.Modal(modalEl);
  const titleEl = document.getElementById('activityModalTitle');
  const bodyEl = document.getElementById('activityModalBody');

  const previewModalEl = document.getElementById('emailPreviewModal');
  const previewModal = previewModalEl ? new bootstrap.Modal(previewModalEl) : null;
  const previewBodyEl = document.getElementById('emailPreviewBody');

  async function loadActivity(kind, id, title) {
    titleEl.textContent = title;
    bodyEl.dataset.kind = kind;
    bodyEl.dataset.id = id;
    bodyEl.innerHTML = '<div class="text-muted">Loading...</div>';
    modal.show();

    try {
      const res = await fetch(apiBase(kind, id));
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      bodyEl.innerHTML = renderActivity(data.activity);
    } catch (err) {
      bodyEl.innerHTML = `<div class="text-danger">Failed to load: ${err.message}</div>`;
    }
  }

  links.forEach((link) => {
    link.addEventListener('click', () => {
      loadActivity(link.dataset.kind, link.dataset.id, link.textContent.trim());
    });
  });

  // Event delegation: the modal body is re-rendered each time, so handle
  // clicks on its "Find related emails" / "Link this email" buttons here.
  bodyEl.addEventListener('click', async (e) => {
    const findBtn = e.target.closest('.find-emails-btn');
    if (findBtn) {
      const kind = bodyEl.dataset.kind;
      const id = bodyEl.dataset.id;
      const resultsEl = bodyEl.querySelector('.email-candidates');
      resultsEl.innerHTML = '<div class="text-muted small">Searching inbox...</div>';
      try {
        const res = await fetch(`${apiBase(kind, id)}/email-candidates`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        resultsEl.innerHTML = renderCandidates(data.candidates);
      } catch (err) {
        resultsEl.innerHTML = `<div class="text-danger small">${err.message}</div>`;
      }
      return;
    }

    const linkBtn = e.target.closest('.link-email-btn');
    if (linkBtn) {
      const kind = bodyEl.dataset.kind;
      const id = bodyEl.dataset.id;
      const payload = {
        subject: linkBtn.dataset.subject,
        date: linkBtn.dataset.date,
        messageId: linkBtn.dataset.messageId
      };
      linkBtn.disabled = true;
      linkBtn.textContent = 'Linking...';
      try {
        const res = await fetch(`${apiBase(kind, id)}/link-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        bodyEl.innerHTML = renderActivity(data.activity);
      } catch (err) {
        alert('Could not link email: ' + err.message);
        linkBtn.disabled = false;
        linkBtn.textContent = 'Link';
      }
      return;
    }

    // "View email" — opens a live, read-only preview fetched fresh over
    // IMAP each time. Nothing here gets saved to Airtable or cached locally.
    const viewBtn = e.target.closest('.view-email-btn');
    if (viewBtn && previewModal) {
      const kind = bodyEl.dataset.kind;
      const id = bodyEl.dataset.id;
      previewBodyEl.innerHTML = '<div class="text-muted">Loading email...</div>';
      previewModal.show();
      try {
        const res = await fetch(`${apiBase(kind, id)}/email-preview`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        previewBodyEl.innerHTML = renderEmailPreview(data.email);
      } catch (err) {
        previewBodyEl.innerHTML = `<div class="text-danger">${escapeHtml(err.message)}</div>`;
      }
    }
  });
}

function renderEmailPreview(e) {
  const date = e.date ? new Date(e.date).toLocaleString() : '';
  return `
    <div class="mb-2"><div class="small text-muted">Subject</div><div class="fw-semibold">${escapeHtml(e.subject)}</div></div>
    <div class="mb-2"><div class="small text-muted">From</div><div>${escapeHtml(e.from)}</div></div>
    <div class="mb-3"><div class="small text-muted">Date</div><div>${escapeHtml(date)}</div></div>
    <hr>
    <div style="white-space: pre-wrap;">${escapeHtml(e.text)}</div>
  `;
}

function renderCandidates(candidates) {
  if (!candidates || !candidates.length) {
    return '<div class="text-muted small">No matching emails found in the Inbox.</div>';
  }
  return `<ul class="list-group list-group-flush mt-2">${candidates
    .map((c) => {
      const date = c.date ? new Date(c.date).toISOString().slice(0, 10) : '';
      return `<li class="list-group-item d-flex justify-content-between align-items-center px-0">
        <div>
          <div class="small fw-semibold">${escapeHtml(c.subject)}</div>
          <div class="text-muted small">${escapeHtml(c.from)} &middot; ${date}</div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-primary link-email-btn"
          data-subject="${escapeHtml(c.subject)}" data-date="${date}" data-message-id="${escapeHtml(c.messageId || '')}">
          Link
        </button>
      </li>`;
    })
    .join('')}</ul>`;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function renderActivity(a) {
  const row = (label, value) =>
    value ? `<div class="mb-2"><div class="small text-muted">${label}</div><div>${value}</div></div>` : '';

  const linkedEmail = a.emailSubject
    ? `<div class="mb-2"><div class="small text-muted">Linked email</div>
        <div>${escapeHtml(a.emailSubject)} <span class="text-muted small">(${a.emailDate || ''})</span>
          <button type="button" class="btn btn-sm btn-link p-0 ms-1 view-email-btn">View</button>
        </div>
      </div>`
    : '';

  return [
    row('Date', a.date),
    row('Type', a.type),
    row('Project', a.projectNames && a.projectNames.length ? a.projectNames.join(', ') : ''),
    row('Status / Result', a.result || a.status),
    row('Details', a.details ? a.details.replace(/\n/g, '<br>') : ''),
    row('Deadline', a.deadline),
    linkedEmail,
    `<div class="mt-3">
      <button type="button" class="btn btn-sm btn-outline-secondary find-emails-btn">Find related emails</button>
      <div class="email-candidates"></div>
    </div>`
  ].join('');
}

function initCompanySearch() {
  const input = document.getElementById('companySearch');
  if (!input) return;
  const rows = document.querySelectorAll('#companiesTable tbody tr');

  input.addEventListener('input', () => {
    const term = input.value.toLowerCase();
    rows.forEach((row) => {
      row.style.display = row.textContent.toLowerCase().includes(term) ? '' : 'none';
    });
  });
}

// ── File chips: hover preview + admin remove ────────────────────────────────
(function () {
  if (window.__fileChips) return; window.__fileChips = true;
  var pop = null, timer = null, current = null;
  function esc(t) { return String(t || '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hide() { clearTimeout(timer); current = null; if (pop) pop.hidden = true; }
  function place(chip) {
    var r = chip.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    var left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    var top = r.top - ph - 8 < 8 ? r.bottom + 8 : r.top - ph - 8;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  function show(chip) {
    if (!pop) { pop = document.createElement('div'); pop.className = 'fc-pop'; pop.hidden = true; document.body.appendChild(pop); }
    var k = chip.dataset.fcKind, url = chip.dataset.fcUrl, name = chip.dataset.fcName, size = chip.dataset.fcSize;
    var body = k === 'image' ? '<img src="' + esc(url) + '" alt="">'
      : k === 'pdf' ? '<iframe src="' + esc(url) + '#toolbar=0&view=FitH" title="' + esc(name) + '"></iframe>'
      : '<div class="fc-pop-file"><i class="bi bi-file-earmark"></i></div>';
    pop.innerHTML = '<div class="fc-pop-media fc-pop-' + k + '">' + body + '</div><div class="fc-pop-meta"><span>' + esc(name) + '</span>' + (size ? '<b>' + esc(size) + '</b>' : '') + '</div>';
    pop.hidden = false; place(chip);
    var img = pop.querySelector('img'); if (img) img.onload = function () { if (current === chip) place(chip); };
  }
  document.addEventListener('mouseover', function (e) {
    var chip = e.target.closest && e.target.closest('.fc');
    if (!chip || chip === current) return;
    if (e.target.closest('.fc-x')) return;
    current = chip; clearTimeout(timer);
    timer = setTimeout(function () { if (current === chip) show(chip); }, 250);
  });
  document.addEventListener('mouseout', function (e) {
    var chip = e.target.closest && e.target.closest('.fc');
    if (chip && (!e.relatedTarget || !chip.contains(e.relatedTarget))) hide();
  });
  document.addEventListener('scroll', hide, true);

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-fc-del]'); if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    var chip = btn.closest('.fc'), name = chip ? chip.dataset.fcName : 'this file';
    if (!confirm('Remove "' + name + '"? This deletes the file and can\'t be undone.')) return;
    hide(); chip.classList.add('is-removing'); btn.disabled = true;
    fetch('/attachments/' + btn.dataset.fcDel + '/delete', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || 'Failed'); }); })
      .then(function () { var list = chip.parentElement; chip.remove(); if (list && !list.children.length) list.remove(); })
      .catch(function (err) { chip.classList.remove('is-removing'); btn.disabled = false; alert(err.message || 'Could not remove the attachment.'); });
  });
})();
