import React from 'react';
import ReactPDF, { Document, Page, Text, View, StyleSheet, renderToStream, renderToBuffer } from '@react-pdf/renderer';

const h = React.createElement;

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 36,
    color: '#334155',
    lineHeight: 1.4,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  brandContainer: {
    flexDirection: 'column',
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  logoBox: {
    width: 24,
    height: 24,
    backgroundColor: '#0f172a',
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 6,
  },
  logoBoxText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  brandTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#0f172a',
    letterSpacing: 0.5,
  },
  brandSubtitle: {
    fontSize: 7.5,
    color: '#64748b',
    marginTop: 1,
  },
  quoteTitleContainer: {
    alignItems: 'flex-end',
  },
  quoteTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#2563eb',
    letterSpacing: 0.8,
  },
  quoteNumber: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#0f172a',
    marginTop: 3,
  },
  statusBadge: {
    marginTop: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 3,
    backgroundColor: '#f1f5f9',
    alignSelf: 'flex-end',
  },
  statusBadgeText: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#475569',
    textTransform: 'uppercase',
  },
  metaGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  metaCol: {
    width: '48%',
  },
  metaHeading: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  metaName: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#0f172a',
    marginBottom: 2,
  },
  metaText: {
    fontSize: 8.5,
    color: '#475569',
    marginBottom: 2,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  metaLabel: {
    fontSize: 8,
    color: '#64748b',
  },
  metaValue: {
    fontSize: 8,
    fontWeight: 'bold',
    color: '#1e293b',
  },
  table: {
    marginTop: 6,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  tableHeaderCell: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#475569',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    paddingVertical: 7,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  colDesc: {
    flex: 5,
  },
  colQty: {
    flex: 1.5,
    textAlign: 'center',
  },
  colPrice: {
    flex: 2,
    textAlign: 'right',
  },
  colAmount: {
    flex: 2,
    textAlign: 'right',
  },
  itemTitle: {
    fontSize: 8.5,
    fontWeight: 'bold',
    color: '#1e293b',
  },
  itemSubtitle: {
    fontSize: 7.5,
    color: '#64748b',
    marginTop: 1,
  },
  emptyTableText: {
    fontSize: 8.5,
    color: '#94a3b8',
    textAlign: 'center',
    paddingVertical: 10,
    fontStyle: 'italic',
  },
  footerSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
  },
  notesBox: {
    width: '52%',
    padding: 8,
    backgroundColor: '#f8fafc',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  notesTitle: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#475569',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  notesContent: {
    fontSize: 7.5,
    color: '#64748b',
    lineHeight: 1.35,
  },
  totalsBox: {
    width: '42%',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2.5,
  },
  totalRowFinal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    marginTop: 4,
    borderTopWidth: 1.5,
    borderTopColor: '#0f172a',
  },
  totalLabel: {
    fontSize: 8,
    color: '#64748b',
  },
  totalValue: {
    fontSize: 8,
    fontWeight: 'bold',
    color: '#1e293b',
  },
  grandTotalLabel: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  grandTotalValue: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#2563eb',
  },
  signatureSection: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 12,
  },
  signatureGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  signatureCol: {
    width: '46%',
  },
  signatureTitle: {
    fontSize: 8,
    fontWeight: 'bold',
    color: '#475569',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 28,
  },
  signatureLine: {
    borderBottomWidth: 1,
    borderBottomColor: '#94a3b8',
    marginBottom: 4,
  },
  signatureLabel: {
    fontSize: 7,
    color: '#64748b',
    marginBottom: 2,
  },
  pageFooter: {
    position: 'absolute',
    bottom: 16,
    left: 36,
    right: 36,
    textAlign: 'center',
    fontSize: 7,
    color: '#94a3b8',
    borderTopWidth: 0.5,
    borderTopColor: '#e2e8f0',
    paddingTop: 4,
  },
});

function formatCurrency(val) {
  const num = Number(val) || 0;
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(dateVal) {
  if (!dateVal) return 'N/A';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return String(dateVal);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function createQuotePdfDocument(quote = {}, options = {}) {
  const companyName = options.companyName || quote.vendorName || 'Tunaxa CRM';
  const quoteNumber =
    quote.quoteNumber ||
    quote.quote_number ||
    quote.number ||
    (quote.id ? `Q-${quote.id.slice(0, 8).toUpperCase()}` : 'Q-DRAFT');
  const quoteStatus = quote.status || 'Draft';
  const quoteTitle = quote.title || quote.name || 'Sales Quote';

  const issueDate = quote.createdAt || quote.created_at || quote.date || new Date();
  const expiryDate = quote.expirationDate || quote.expiration_date || quote.expiresAt;

  const rawItems = quote.items || quote.lineItems || [];
  const items = Array.isArray(rawItems)
    ? rawItems
    : typeof rawItems === 'string'
    ? JSON.parse(rawItems || '[]')
    : [];

  const subtotal =
    quote.subtotal !== undefined
      ? Number(quote.subtotal) || 0
      : items.reduce((acc, it) => acc + (Number(it.amount || it.total) || (Number(it.quantity || it.qty || 1) * Number(it.unitPrice || it.unit_price || it.price || 0))), 0);

  const discount = Number(quote.discount) || 0;
  const tax = Number(quote.tax) || 0;
  const grandTotal = quote.total !== undefined ? Number(quote.total) || 0 : subtotal - discount + tax;

  const clientName =
    quote.contactName ||
    quote.contact ||
    quote.clientName ||
    quote.customerName ||
    'Valued Customer';
  const clientCompany = quote.companyName || quote.company || '';
  const clientEmail = quote.contactEmail || quote.customerEmail || quote.email || '';

  const notesText =
    quote.notes ||
    options.terms ||
    'Standard Payment Terms: Net 30 days from invoice date. This quotation is valid until the expiration date indicated above.';

  return h(
    Document,
    null,
    h(
      Page,
      { size: 'A4', style: styles.page },
      // Header
      h(
        View,
        { style: styles.header },
        h(
          View,
          { style: styles.brandContainer },
          h(
            View,
            { style: styles.logoRow },
            h(View, { style: styles.logoBox }, h(Text, { style: styles.logoBoxText }, 'T')),
            h(Text, { style: styles.brandTitle }, companyName)
          ),
          h(Text, { style: styles.brandSubtitle }, 'Revenue Operations & Customer Cloud')
        ),
        h(
          View,
          { style: styles.quoteTitleContainer },
          h(Text, { style: styles.quoteTitle }, 'QUOTE'),
          h(Text, { style: styles.quoteNumber }, quoteNumber),
          h(
            View,
            { style: styles.statusBadge },
            h(Text, { style: styles.statusBadgeText }, quoteStatus)
          )
        )
      ),

      // Metadata Grid
      h(
        View,
        { style: styles.metaGrid },
        h(
          View,
          { style: styles.metaCol },
          h(Text, { style: styles.metaHeading }, 'Prepared For:'),
          h(Text, { style: styles.metaName }, clientName),
          clientCompany ? h(Text, { style: styles.metaText }, clientCompany) : null,
          clientEmail ? h(Text, { style: styles.metaText }, clientEmail) : null,
          quoteTitle ? h(Text, { style: styles.metaText }, `Subject: ${quoteTitle}`) : null
        ),
        h(
          View,
          { style: styles.metaCol },
          h(Text, { style: styles.metaHeading }, 'Quote Details:'),
          h(
            View,
            { style: styles.metaRow },
            h(Text, { style: styles.metaLabel }, 'Quote Date:'),
            h(Text, { style: styles.metaValue }, formatDate(issueDate))
          ),
          h(
            View,
            { style: styles.metaRow },
            h(Text, { style: styles.metaLabel }, 'Valid Through:'),
            h(Text, { style: styles.metaValue }, formatDate(expiryDate))
          ),
          quote.dealId
            ? h(
                View,
                { style: styles.metaRow },
                h(Text, { style: styles.metaLabel }, 'Deal Reference:'),
                h(Text, { style: styles.metaValue }, String(quote.dealId).slice(0, 12))
              )
            : null
        )
      ),

      // Line Items Table
      h(
        View,
        { style: styles.table },
        h(
          View,
          { style: styles.tableHeader },
          h(Text, { style: [styles.tableHeaderCell, styles.colDesc] }, 'Description'),
          h(Text, { style: [styles.tableHeaderCell, styles.colQty] }, 'Qty'),
          h(Text, { style: [styles.tableHeaderCell, styles.colPrice] }, 'Unit Price'),
          h(Text, { style: [styles.tableHeaderCell, styles.colAmount] }, 'Amount')
        ),
        items.length === 0
          ? h(Text, { style: styles.emptyTableText }, 'No line items listed on this quote.')
          : items.map((item, idx) => {
              const qty = Number(item.quantity || item.qty || 1);
              const price = Number(item.unitPrice || item.unit_price || item.price || 0);
              const amount = Number(item.amount || item.total) || qty * price;
              const desc = item.description || item.name || item.title || `Item ${idx + 1}`;
              const sku = item.sku ? `SKU: ${item.sku}` : '';

              return h(
                View,
                {
                  key: item.id || `item_${idx}`,
                  style: [
                    styles.tableRow,
                    { backgroundColor: idx % 2 === 1 ? '#f8fafc' : '#ffffff' },
                  ],
                },
                h(
                  View,
                  { style: styles.colDesc },
                  h(Text, { style: styles.itemTitle }, desc),
                  sku ? h(Text, { style: styles.itemSubtitle }, sku) : null
                ),
                h(Text, { style: [styles.metaText, styles.colQty] }, String(qty)),
                h(Text, { style: [styles.metaText, styles.colPrice] }, formatCurrency(price)),
                h(Text, { style: [styles.metaText, styles.colAmount] }, formatCurrency(amount))
              );
            })
      ),

      // Footer: Notes & Totals
      h(
        View,
        { style: styles.footerSection },
        h(
          View,
          { style: styles.notesBox },
          h(Text, { style: styles.notesTitle }, 'Notes & Terms'),
          h(Text, { style: styles.notesContent }, notesText)
        ),
        h(
          View,
          { style: styles.totalsBox },
          h(
            View,
            { style: styles.totalRow },
            h(Text, { style: styles.totalLabel }, 'Subtotal:'),
            h(Text, { style: styles.totalValue }, formatCurrency(subtotal))
          ),
          discount > 0
            ? h(
                View,
                { style: styles.totalRow },
                h(Text, { style: styles.totalLabel }, 'Discount:'),
                h(Text, { style: styles.totalValue }, `-${formatCurrency(discount)}`)
              )
            : null,
          tax > 0
            ? h(
                View,
                { style: styles.totalRow },
                h(Text, { style: styles.totalLabel }, 'Tax / VAT:'),
                h(Text, { style: styles.totalValue }, formatCurrency(tax))
              )
            : null,
          h(
            View,
            { style: styles.totalRowFinal },
            h(Text, { style: styles.grandTotalLabel }, 'Total:'),
            h(Text, { style: styles.grandTotalValue }, formatCurrency(grandTotal))
          )
        )
      ),

      // Signature Block
      h(
        View,
        { style: styles.signatureSection },
        h(
          View,
          { style: styles.signatureGrid },
          h(
            View,
            { style: styles.signatureCol },
            h(Text, { style: styles.signatureTitle }, 'Prepared By:'),
            h(View, { style: styles.signatureLine }),
            h(Text, { style: styles.signatureLabel }, 'Authorized Signature'),
            h(Text, { style: styles.signatureLabel }, `Date: ${formatDate(new Date())}`)
          ),
          h(
            View,
            { style: styles.signatureCol },
            h(Text, { style: styles.signatureTitle }, 'Accepted By (Client):'),
            h(View, { style: styles.signatureLine }),
            h(Text, { style: styles.signatureLabel }, 'Authorized Signature & Title'),
            h(Text, { style: styles.signatureLabel }, 'Date: ________________________')
          )
        )
      ),

      // Page Footer
      h(
        Text,
        { style: styles.pageFooter },
        `Generated by ${companyName} • Quote Ref: ${quoteNumber}`
      )
    )
  );
}

export async function renderQuotePdfStream(quote, options = {}) {
  const doc = createQuotePdfDocument(quote, options);
  return await renderToStream(doc);
}

export async function renderQuotePdfBuffer(quote, options = {}) {
  const doc = createQuotePdfDocument(quote, options);
  return await renderToBuffer(doc);
}
