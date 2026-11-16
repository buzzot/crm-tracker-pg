const express = require('express');
const router = express.Router();
const crm = require('../services/crm');

// Default win likelihood per stage, used for the weighted forecast
const STAGE_PROB = { 'Prospecting': 0.1, 'Qualification': 0.2, 'Needs Analysis': 0.4, 'Proposal / Price Quote': 0.6, 'Negotiation': 0.8, 'Closed Won': 1, 'Closed Lost': 0 };
const CLOSED = ['Closed Won', 'Closed Lost'];
const STALE_DAYS = 21;

router.get('/pipeline', async (req, res, next) => {
  try {
    const user = req.session.user;
    const stageChoices = crm.schema.tables.deals.stageChoices;
    let [deals, companies] = await Promise.all([crm.listDeals(user), crm.listCompanies(user)]);
    if (user.role === 'Sales') deals = crm.scopeToOwner(deals, user.email);
    const logos = await crm.companyLogos(deals.map((d) => d.companyId));
    const now = Date.now();
    deals = deals.map((d) => {
      const stage = stageChoices.includes(d.stage) ? d.stage : 'Prospecting';
      const idleDays = d.updatedAt ? Math.floor((now - new Date(d.updatedAt).getTime()) / 86400000) : null;
      return { ...d, stage, companyLogo: d.companyId ? logos[d.companyId] || null : null, idleDays,
        stale: !CLOSED.includes(stage) && idleDays !== null && idleDays >= STALE_DAYS,
        mine: d.ownerId === user.id };
    });
    const open = deals.filter((d) => !CLOSED.includes(d.stage));
    const won = deals.filter((d) => d.stage === 'Closed Won');
    const lost = deals.filter((d) => d.stage === 'Closed Lost');
    const sum = (arr) => arr.reduce((s, d) => s + (d.amount || 0), 0);
    const stats = {
      openCount: open.length, openValue: sum(open),
      weighted: Math.round(open.reduce((s, d) => s + (d.amount || 0) * (STAGE_PROB[d.stage] || 0), 0)),
      wonCount: won.length, wonValue: sum(won), lostCount: lost.length,
      winRate: won.length + lost.length ? Math.round(won.length / (won.length + lost.length) * 100) : null,
      staleCount: open.filter((d) => d.stale).length,
    };
    const owners = [...new Map(deals.filter((d) => d.ownerId).map((d) => [d.ownerId, d.ownerName])).entries()]
      .map(([id, name]) => ({ id, name: name || 'Unknown' })).sort((a, b) => a.name.localeCompare(b.name));
    res.render('pipeline', {
      title: 'Pipeline', deals, stats, owners, stageChoices, stageProb: STAGE_PROB,
      companies: companies.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    });
  } catch (err) {
    next(err);
  }
});

// Dynamic stage update (drag/drop or menu), no full page reload.
router.patch('/pipeline/api/deals/:id/stage', async (req, res) => {
  try {
    const { stage } = req.body;
    if (!crm.schema.tables.deals.stageChoices.includes(stage)) return res.status(400).json({ ok: false, error: 'Unknown stage.' });
    const visible = await crm.listDeals(req.session.user);
    if (!visible.some((d) => d.id === req.params.id)) return res.status(404).json({ ok: false, error: 'Deal not found.' });
    await crm.updateDealStage(req.params.id, stage);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'Could not move the deal.' });
  }
});

module.exports = router;
