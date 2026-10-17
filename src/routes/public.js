const router = require('express').Router();
const db = require('../db/database');

router.get('/', (req, res) => {
  const tours = db.prepare('SELECT * FROM tours WHERE activo = 1').all();
  res.render('landing', { tours });
});

module.exports = router;
