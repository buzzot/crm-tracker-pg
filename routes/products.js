const express = require('express');
const multer = require('multer');
const router = express.Router();
const crm = require('../services/crm');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

router.get('/products', async (req, res, next) => {
  try {
    const products = await crm.listProductsWithProjects();
    res.render('products', { title: 'Products', products });
  } catch (err) {
    next(err);
  }
});

router.get('/products/:id', async (req, res, next) => {
  try {
    const product = await crm.getProductDetail(req.params.id);
    res.render('product-detail', {
      title: product.name || 'Product',
      product,
      categoryChoices: crm.schema.tables.products.categoryChoices,
      phaseChoices: crm.schema.tables.products.phaseChoices,
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post('/products/:id/details', async (req, res, next) => {
  try {
    const { category, phase, inputVoltage, boardSize, horsePower, maxInputPower, maxInputCurrent, maxOutputCurrent, notes } = req.body;
    await crm.updateProduct({ productId: req.params.id, category, phase, inputVoltage, boardSize, horsePower, maxInputPower, maxInputCurrent, maxOutputCurrent, notes });
    res.redirect(`/products/${req.params.id}`);
  } catch (err) {
    try {
      const product = await crm.getProductDetail(req.params.id);
      return res.status(400).render('product-detail', {
        title: product.name || 'Product',
        product,
        categoryChoices: crm.schema.tables.products.categoryChoices,
        phaseChoices: crm.schema.tables.products.phaseChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

router.post('/products/:id/image', upload.single('image'), async (req, res, next) => {
  try {
    if (req.file) {
      await crm.replaceProductImage(req.params.id, req.file);
    }
    res.redirect(`/products/${req.params.id}`);
  } catch (err) {
    try {
      const product = await crm.getProductDetail(req.params.id);
      return res.status(400).render('product-detail', {
        title: product.name || 'Product',
        product,
        categoryChoices: crm.schema.tables.products.categoryChoices,
        phaseChoices: crm.schema.tables.products.phaseChoices,
        error: err.message
      });
    } catch (err2) {
      next(err2);
    }
  }
});

module.exports = router;
