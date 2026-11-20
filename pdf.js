// PDF (Chrome sans interface) et Factur-X : XML CII profil EN 16931 embarqué dans un PDF/A-3.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { PDFDocument, PDFName, PDFString, AFRelationship } from 'pdf-lib';
import { totaux, r2 } from './public/calc.js';

const CHROMES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const ICCS = [process.env.ICC_PROFILE, 'C:/Windows/System32/spool/drivers/color/sRGB Color Space Profile.icm',
  '/usr/share/color/icc/colord/sRGB.icc', '/usr/share/color/icc/sRGB.icc', '/usr/share/color/icc/ghostscript/srgb.icc'];
const firstFile = list => list.find(f => f && fs.existsSync(f));

let browser;
async function withPage(html, fn) {
  if (!browser?.connected) {
    const executablePath = firstFile(CHROMES);
    if (!executablePath) throw Object.assign(new Error('PDF indisponible : installez Chrome ou Chromium, ou renseignez CHROME_PATH.'), { status: 503 });
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  }
  const page = await browser.newPage();
  try {
    await page.setJavaScriptEnabled(false); // gabarits fournis par les utilisateurs
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(await fn(page));
  } finally { await page.close(); }
}
export const htmlToPdf = html => withPage(html, p => p.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
export const htmlToPng = html => withPage(html, async p => { await p.setViewport({ width: 1000, height: 800 }); return p.screenshot({ fullPage: true, type: 'png' }); });

// ---------- XML CII (EN 16931) ----------
const x = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const a = n => r2(n).toFixed(2);
const d102 = d => `<udt:DateTimeString format="102">${String(d || '').replace(/-/g, '')}</udt:DateTimeString>`;
const UNITS = { 'u': 'C62', 'm²': 'MTK', 'm2': 'MTK', 'ml': 'MTR', 'm': 'MTR', 'm³': 'MTQ', 'm3': 'MTQ', 'h': 'HUR', 'jour': 'DAY', 'kg': 'KGM', 'forfait': 'LS', 'ens': 'LS', 't': 'TNE', 'l': 'LTR' };
const unit = u => UNITS[String(u || '').trim().toLowerCase()] || 'C62';
const siren = s => String(s || '').replace(/\D/g, '').slice(0, 9);

// « 12 rue des Lilas\n69003 Lyon » → lignes, code postal, ville
function adresse(txt) {
  const lines = String(txt || '').split('\n').map(l => l.trim()).filter(Boolean);
  const i = lines.findIndex(l => /^\d{5}\s+\S/.test(l));
  const [cp, ville] = i >= 0 ? [lines[i].slice(0, 5), lines[i].slice(5).trim()] : ['', ''];
  const rest = lines.filter((_, j) => j !== i);
  return `<ram:PostalTradeAddress>${cp ? `<ram:PostcodeCode>${x(cp)}</ram:PostcodeCode>` : ''}${rest.slice(0, 3).map((l, j) => `<ram:Line${['One', 'Two', 'Three'][j]}>${x(l)}</ram:Line${['One', 'Two', 'Three'][j]}>`).join('')}${ville ? `<ram:CityName>${x(ville)}</ram:CityName>` : ''}<ram:CountryID>FR</ram:CountryID></ram:PostalTradeAddress>`;
}

export function ciiXml(doc, s) {
  const franchise = !!s.franchise_tva, avoir = doc.kind === 'avoir', sign = avoir ? -1 : 1;
  const d = doc.data, c = d.client || {}, t = totaux(d, franchise);
  const cat = taux => (franchise || !taux ? 'E' : 'S');
  const exo = franchise ? 'TVA non applicable, art. 293 B du CGI' : 'Exonération de TVA';
  const tax = taux => `<ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>${cat(taux)}</ram:CategoryCode><ram:RateApplicablePercent>${franchise ? 0 : taux}</ram:RateApplicablePercent>`;
  const lignes = (d.lignes || []).filter(l => l.type !== 'section');
  // Prix net jamais négatif (BR-27) : le signe passe sur la quantité.
  const items = lignes.map((l, i) => {
    let q = +l.qte * sign, pu = +l.pu;
    if (pu < 0) { pu = -pu; q = -q; }
    return `<ram:IncludedSupplyChainTradeLineItem><ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
<ram:SpecifiedTradeProduct><ram:Name>${x(l.designation || 'Prestation')}</ram:Name>${l.description ? `<ram:Description>${x(l.description)}</ram:Description>` : ''}</ram:SpecifiedTradeProduct>
<ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>${a(pu)}</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${unit(l.unite)}">${q}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
<ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax>${tax(+l.tva || 0)}</ram:ApplicableTradeTax>
<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${a(sign * r2(l.qte * l.pu))}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>
</ram:IncludedSupplyChainTradeLineItem>`;
  }).join('\n');
  // Remise globale ventilée par taux = total des lignes du taux − base imposable du taux.
  const brutTaux = {};
  for (const l of lignes) { const k = franchise ? 0 : +l.tva || 0; brutTaux[k] = (brutTaux[k] || 0) + r2(l.qte * l.pu); }
  const remises = t.bases.map(b => ({ taux: b.taux, montant: r2(brutTaux[b.taux] - b.base) })).filter(r => r.montant);
  const tvaTotal = r2(t.ttc - t.ht);
  const prepaid = avoir ? 0 : r2(doc.paye || 0);
  const vendeurSiren = siren(s.siret), clientSiren = siren(c.siret);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>
<rsm:ExchangedDocument><ram:ID>${x(doc.numero)}</ram:ID><ram:TypeCode>${avoir ? 381 : doc.kind === 'acompte' ? 386 : 380}</ram:TypeCode><ram:IssueDateTime>${d102(doc.date)}</ram:IssueDateTime>
${[d.objet && `Objet : ${d.objet}`, s.mentions, franchise && exo].filter(Boolean).map(n => `<ram:IncludedNote><ram:Content>${x(n)}</ram:Content></ram:IncludedNote>`).join('')}</rsm:ExchangedDocument>
<rsm:SupplyChainTradeTransaction>
${items}
<ram:ApplicableHeaderTradeAgreement>
<ram:SellerTradeParty><ram:Name>${x(s.nom)}</ram:Name>${vendeurSiren ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${vendeurSiren}</ram:ID></ram:SpecifiedLegalOrganization>` : ''}
${adresse(s.adresse)}${s.email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(s.email)}</ram:URIID></ram:URIUniversalCommunication>` : ''}
${s.tva_intra && !franchise ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${x(s.tva_intra.replace(/\s/g, ''))}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}</ram:SellerTradeParty>
<ram:BuyerTradeParty><ram:Name>${x(c.nom || 'Client')}</ram:Name>${clientSiren ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${clientSiren}</ram:ID></ram:SpecifiedLegalOrganization>` : ''}
${adresse(c.adresse)}${c.email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(c.email)}</ram:URIID></ram:URIUniversalCommunication>` : ''}</ram:BuyerTradeParty>
</ram:ApplicableHeaderTradeAgreement>
<ram:ApplicableHeaderTradeDelivery>${d.adresse_chantier ? `<ram:ShipToTradeParty>${adresse(d.adresse_chantier)}</ram:ShipToTradeParty>` : ''}</ram:ApplicableHeaderTradeDelivery>
<ram:ApplicableHeaderTradeSettlement><ram:PaymentReference>${x(doc.numero)}</ram:PaymentReference><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
${s.iban && !avoir ? `<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${x(s.iban.replace(/\s/g, ''))}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>` : ''}
${t.bases.map(b => `<ram:ApplicableTradeTax><ram:CalculatedAmount>${a(sign * b.montant)}</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode>${cat(b.taux) === 'E' ? `<ram:ExemptionReason>${x(exo)}</ram:ExemptionReason>` : ''}<ram:BasisAmount>${a(sign * b.base)}</ram:BasisAmount><ram:CategoryCode>${cat(b.taux)}</ram:CategoryCode>${franchise ? '<ram:ExemptionReasonCode>VATEX-FR-FRANCHISE</ram:ExemptionReasonCode>' : ''}${s.tva_debits || franchise || !b.taux ? '' : '<ram:DueDateTypeCode>432</ram:DueDateTypeCode>'}<ram:RateApplicablePercent>${franchise ? 0 : b.taux}</ram:RateApplicablePercent></ram:ApplicableTradeTax>`).join('\n')}
${remises.map(r => `<ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator><ram:ActualAmount>${a(sign * r.montant)}</ram:ActualAmount><ram:Reason>Remise</ram:Reason><ram:CategoryTradeTax>${tax(r.taux)}</ram:CategoryTradeTax></ram:SpecifiedTradeAllowanceCharge>`).join('\n')}
${doc.echeance && !avoir ? `<ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime>${d102(doc.echeance)}</ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>` : ''}
<ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>${a(sign * t.brut)}</ram:LineTotalAmount>${remises.length ? `<ram:AllowanceTotalAmount>${a(sign * t.remise)}</ram:AllowanceTotalAmount>` : ''}
<ram:TaxBasisTotalAmount>${a(sign * t.ht)}</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">${a(sign * tvaTotal)}</ram:TaxTotalAmount><ram:GrandTotalAmount>${a(sign * t.ttc)}</ram:GrandTotalAmount>
${prepaid ? `<ram:TotalPrepaidAmount>${a(prepaid)}</ram:TotalPrepaidAmount>` : ''}<ram:DuePayableAmount>${a(sign * t.ttc - prepaid)}</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>
${avoir && doc.parent_numero ? `<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${x(doc.parent_numero)}</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>` : ''}
</ram:ApplicableHeaderTradeSettlement>
</rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

const fxProp = (name, desc) => `<rdf:li rdf:parseType="Resource"><pdfaProperty:name>${name}</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>${desc}</pdfaProperty:description></rdf:li>`;

// Ajoute le XML Factur-X et les métadonnées PDF/A-3 au PDF de la facture.
export async function facturx(pdfBytes, xml, { titre, auteur }) {
  const pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const now = new Date(), iso = now.toISOString().replace(/\.\d+Z$/, 'Z');
  await pdf.attach(Buffer.from(xml, 'utf8'), 'factur-x.xml', {
    mimeType: 'text/xml', description: 'Factur-X', creationDate: now, modificationDate: now, afRelationship: AFRelationship.Alternative,
  });
  pdf.setTitle(titre); pdf.setAuthor(auteur); pdf.setCreator('Kadra'); pdf.setProducer('Kadra');
  pdf.setCreationDate(now); pdf.setModificationDate(now);
  const xmp = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>application/pdf</dc:format><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${x(titre)}</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>${x(auteur)}</rdf:li></rdf:Seq></dc:creator></rdf:Description>
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreatorTool>Kadra</xmp:CreatorTool><xmp:CreateDate>${iso}</xmp:CreateDate><xmp:ModifyDate>${iso}</xmp:ModifyDate></rdf:Description>
<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Producer>Kadra</pdf:Producer></rdf:Description>
<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"><fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>factur-x.xml</fx:DocumentFileName><fx:Version>1.0</fx:Version><fx:ConformanceLevel>EN 16931</fx:ConformanceLevel></rdf:Description>
<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource"><pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
<pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI><pdfaSchema:prefix>fx</pdfaSchema:prefix>
<pdfaSchema:property><rdf:Seq>${fxProp('DocumentFileName', 'name of the embedded XML invoice file')}${fxProp('DocumentType', 'INVOICE')}${fxProp('Version', 'The actual version of the Factur-X XML schema')}${fxProp('ConformanceLevel', 'The conformance level of the embedded Factur-X data')}</rdf:Seq></pdfaSchema:property>
</rdf:li></rdf:Bag></pdfaExtension:schemas></rdf:Description>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  pdf.catalog.set(PDFName.of('Metadata'), pdf.context.register(pdf.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
  const icc = firstFile(ICCS);
  if (icc) {
    const profile = pdf.context.register(pdf.context.stream(fs.readFileSync(icc), { N: 3 }));
    const intent = pdf.context.obj({ Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('sRGB'), Info: PDFString.of('sRGB IEC61966-2.1'), DestOutputProfile: profile });
    pdf.catalog.set(PDFName.of('OutputIntents'), pdf.context.obj([pdf.context.register(intent)]));
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
