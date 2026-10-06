import { auth } from '../middleware/auth.js';
import { repoFor } from '../db/repositories/index.js';
import { pgToLegacy } from '../db/legacy-shape.js';
import { readDb } from '../store.js';
import { renderQuotePdfStream } from '../services/quotePdf.js';

export default function registerQuoteRoutes(app) {
  app.get('/api/quotes/:id/pdf', auth, async (req, res, next) => {
    try {
      const quoteId = req.params.id;
      let quote = null;

      const quotesRepo = repoFor('quotes');
      if (quotesRepo && typeof quotesRepo.findById === 'function') {
        const row = await quotesRepo.findById(quoteId);
        if (row) {
          quote = pgToLegacy(row, 'quotes');
        }
      }

      if (!quote) {
        const db = await readDb();
        quote = (db.quotes || []).find((q) => q.id === quoteId) || null;
      }

      if (!quote) {
        return res.status(404).json({ error: 'Quote not found' });
      }

      // Enrich with company name if referenced
      if (quote.companyId && !quote.companyName) {
        try {
          const compRepo = repoFor('companies');
          const compRow = compRepo ? await compRepo.findById(quote.companyId) : null;
          if (compRow) {
            quote.companyName = compRow.name || compRow.title;
          }
        } catch (_) {}
      }

      // Enrich with contact details if referenced
      if (quote.contactId && (!quote.contactName || !quote.contactEmail)) {
        try {
          const contRepo = repoFor('contacts');
          const contRow = contRepo ? await contRepo.findById(quote.contactId) : null;
          if (contRow) {
            const legacyContact = pgToLegacy(contRow, 'contacts');
            quote.contactName =
              quote.contactName ||
              `${legacyContact.firstName || ''} ${legacyContact.lastName || ''}`.trim() ||
              legacyContact.name;
            quote.contactEmail = quote.contactEmail || legacyContact.email;
          }
        } catch (_) {}
      }

      const filename = `quote-${quote.quoteNumber || quote.number || quote.id}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

      const stream = await renderQuotePdfStream(quote);
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });
}
