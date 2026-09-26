import { auth } from '../middleware/auth.js';
import { repoFor } from '../db/repositories/index.js';
import { pgToLegacy } from '../db/legacy-shape.js';
import { readDb, mutateDb } from '../store.js';
import { renderQuotePdfStream } from '../services/quotePdf.js';
import { createQuoteSignToken, verifyQuoteSignToken, createQuoteShareLink } from '../services/quoteToken.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATA_URL_REGEX = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

export default function registerQuoteRoutes(app) {
  /**
   * GET /api/quotes/:id/pdf
   * Streams a rendered PDF of the quote.
   */
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

  /**
   * POST /api/quotes/:id/share-link
   * Generates a time-limited public signing link for a quote.
   */
  app.post('/api/quotes/:id/share-link', auth, async (req, res, next) => {
    try {
      const quoteId = req.params.id;
      let quote = null;

      const quotesRepo = repoFor('quotes');
      if (quotesRepo && typeof quotesRepo.findById === 'function') {
        const row = await quotesRepo.findById(quoteId);
        if (row) quote = pgToLegacy(row, 'quotes');
      }

      if (!quote) {
        const db = await readDb();
        quote = (db.quotes || []).find((q) => q.id === quoteId) || null;
      }

      if (!quote) {
        return res.status(404).json({ error: 'Quote not found' });
      }

      const expiresInMs = Number(req.body?.expiresInMs) || 7 * 24 * 60 * 60 * 1000;
      const token = createQuoteSignToken(quoteId, { expiresInMs });
      const shareUrl = `/quotes/${quoteId}/sign?token=${token}`;

      return res.status(200).json({
        token,
        shareUrl,
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/quotes/:id/sign
   * Public e-signature capture endpoint with token validation.
   * Updates quote to 'Signed' and auto-creates a corresponding Contract.
   */
  app.post('/api/quotes/:id/sign', async (req, res, next) => {
    try {
      const quoteId = req.params.id;
      const token = req.body?.token || req.query?.token || req.headers['x-quote-token'];

      if (!token) {
        return res.status(401).json({ error: 'Signature token is required' });
      }

      const verification = verifyQuoteSignToken(token, quoteId);
      if (!verification.valid) {
        return res.status(401).json({ error: 'Invalid or expired signature token' });
      }

      const { signatureDataUrl, signerName, signerEmail } = req.body || {};

      if (!signatureDataUrl || typeof signatureDataUrl !== 'string' || !DATA_URL_REGEX.test(signatureDataUrl.trim())) {
        return res.status(400).json({ error: 'Valid signatureDataUrl is required' });
      }

      if (!signerName || typeof signerName !== 'string' || !signerName.trim()) {
        return res.status(400).json({ error: 'signerName is required' });
      }

      if (!signerEmail || typeof signerEmail !== 'string' || !EMAIL_REGEX.test(signerEmail.trim())) {
        return res.status(400).json({ error: 'Valid signerEmail is required' });
      }

      const quotesRepo = repoFor('quotes');
      let quoteRow = null;
      let legacyQuote = null;

      if (quotesRepo && typeof quotesRepo.findById === 'function') {
        quoteRow = await quotesRepo.findById(quoteId);
      }

      if (!quoteRow) {
        const db = await readDb();
        legacyQuote = (db.quotes || []).find((q) => q.id === quoteId) || null;
      }

      if (!quoteRow && !legacyQuote) {
        return res.status(404).json({ error: 'Quote not found' });
      }

      const currentStatus = (quoteRow?.status || legacyQuote?.status || '').toLowerCase();
      if (currentStatus === 'signed') {
        return res.status(409).json({ error: 'Quote has already been signed' });
      }

      const signerIp = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
      const userAgent = req.headers['user-agent'] || 'Unknown';
      const signedAt = new Date().toISOString();

      const signatureMeta = {
        signerName: signerName.trim(),
        signerEmail: signerEmail.trim().toLowerCase(),
        signatureDataUrl: signatureDataUrl.trim(),
        signedAt,
        signerIp,
        userAgent,
      };

      let updatedQuote = null;

      if (quoteRow) {
        const existingCustomFields =
          typeof quoteRow.custom_fields === 'object' && quoteRow.custom_fields !== null
            ? quoteRow.custom_fields
            : typeof quoteRow.custom_fields === 'string'
            ? JSON.parse(quoteRow.custom_fields || '{}')
            : {};

        const updatedCustomFields = {
          ...existingCustomFields,
          signature: signatureMeta,
        };

        const updatedRow = await quotesRepo.update(quoteRow.id, {
          status: 'Signed',
          custom_fields: updatedCustomFields,
        });
        updatedQuote = pgToLegacy(updatedRow, 'quotes');
      } else {
        await mutateDb((db) => {
          const q = (db.quotes || []).find((x) => x.id === quoteId);
          if (q) {
            q.status = 'Signed';
            q.custom_fields = { ...(q.custom_fields || {}), signature: signatureMeta };
            q.signature = signatureMeta;
            updatedQuote = q;
          }
        });
      }

      // Auto-create Contract record
      const quoteObj = quoteRow ? pgToLegacy(quoteRow, 'quotes') : legacyQuote;
      const quoteNumberStr = quoteObj.quoteNumber || quoteObj.quote_number || '';
      const cleanNum = String(quoteNumberStr).replace(/^Q-/, '') || Date.now();

      const contractData = {
        title: `Contract - ${quoteObj.title || quoteNumberStr || quoteObj.id}`,
        contract_number: `C-${cleanNum}`,
        deal_id: quoteObj.dealId || quoteObj.deal_id || null,
        company_id: quoteObj.companyId || quoteObj.company_id || null,
        contact_id: quoteObj.contactId || quoteObj.contact_id || null,
        quote_id: quoteObj.id,
        status: 'Active',
        value: Number(quoteObj.total) || 0,
        start_date: signedAt,
        terms: quoteObj.terms || quoteObj.notes || 'Standard terms apply.',
        workspace_id: quoteObj.workspaceId || quoteObj.workspace_id || 'default',
        custom_fields: {
          signedQuoteId: quoteObj.id,
          signerEmail: signerEmail.trim().toLowerCase(),
          signerName: signerName.trim(),
        },
      };

      let contract = null;
      const contractsRepo = repoFor('contracts');
      if (contractsRepo && typeof contractsRepo.create === 'function') {
        const contractRow = await contractsRepo.create(contractData);
        contract = contractRow ? pgToLegacy(contractRow, 'contracts') : contractData;
      } else {
        await mutateDb((db) => {
          if (!Array.isArray(db.contracts)) db.contracts = [];
          const newContract = { id: `ct_${Date.now()}`, ...contractData };
          db.contracts.push(newContract);
          contract = newContract;
        });
      }

      return res.status(200).json({
        success: true,
        quote: updatedQuote,
        contract,
      });
    } catch (err) {
      next(err);
    }
  });
}
