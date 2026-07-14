const express = require('express');
const router = express.Router();
const crm = require('../services/crm');

router.get('/pipeline', async (req, res, next) => {
  try {
    const { role, email } = req.session.user;
    const { board: fullBoard, stageChoices } = await crm.getPipelineBoard();
    const board = role === 'Sales'
      ? fullBoard.map((b) => {
          const deals = crm.scopeToOwner(b.deals, email);
          return { ...b, deals, total: deals.reduce((sum, d) => sum + (d.amount || 0), 0) };
        })
      : fullBoard;
    res.render('pipeline', { title: 'Sales Pipeline', board, stageChoices });
  } catch (err) {
    next(err);
  }
});

// Dynamic stage update (drag/drop or dropdown), no full page reload.
router.patch('/pipeline/api/deals/:id/stage', async (req, res) => {
  try {
    const { stage } = req.body;
    const updated = await crm.updateDealStage(req.params.id, stage);
    res.json({ ok: true, deal: updated });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
