/**
 * Templates pour les DEVIS
 * - Envoi initial
 * - Rappel d'expiration
 * - Confirmation d'acceptation
 * - Refus
 */

import { baseStyles, generateFooter, wrapTemplate, EmailTemplateData, renderEmailHeaderLogo, appendGeneratedBySenedText } from './base.template';

export interface QuoteEmailData extends EmailTemplateData {
    clientName: string;
    quoteNumber: string;
    issueDate?: string;
    validUntil?: string;
    amount: number | string;
    subject?: string;
    signUrl?: string;
    viewUrl?: string;
    termsUrl?: string;
    signatureUrl?: string;
    daysUntilExpiry?: number;
    daysRemaining?: number;
    refuseReason?: string;
    reason?: string;
    acceptedDate?: string;
    refusedDate?: string;
}

const formatAmount = (amount: number | string): string => {
    if (typeof amount === 'string') return amount;
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(amount);
};

const formatDate = (date: string): string => {
    return new Date(date).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
};

/**
 * Email d'envoi initial d'un devis
 */
export function quoteNewEmail(data: QuoteEmailData): { subject: string; html: string; text: string } {
    const subject = `📋 Devis ${data.quoteNumber} - ${data.companyName}`;
    const amountStr = formatAmount(data.amount);
    const issueDateStr = data.issueDate ? formatDate(data.issueDate) : '';
    const validUntilStr = data.validUntil ? formatDate(data.validUntil) : '';
    const signatureUrl = data.signUrl || data.signatureUrl;
    
    const content = `
        <div class="header" style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 50%, #6d28d9 100%);">
            ${renderEmailHeaderLogo(data)}
            <h1 class="header-title">Votre Devis</h1>
            <p class="header-subtitle">N° ${data.quoteNumber}</p>
        </div>
        
        <div class="content">
            <p class="greeting">Bonjour <strong>${data.clientName}</strong>,</p>
            
            <p class="message">
                Suite à votre demande, nous avons le plaisir de vous transmettre notre devis.
                ${data.subject ? `<br><br><em>"${data.subject}"</em>` : ''}
            </p>
            
            <div class="info-card">
                <div class="info-row">
                    <span class="info-label">Numéro de devis :</span>
                    <span class="info-value">${data.quoteNumber}</span>
                </div>
                ${issueDateStr ? `
                <div class="info-row">
                    <span class="info-label">Date d'émission :</span>
                    <span class="info-value">${issueDateStr}</span>
                </div>
                ` : ''}
                <div class="info-row">
                    <span class="info-label">Valide jusqu'au :</span>
                    <span class="info-value">${validUntilStr}</span>
                </div>
            </div>
            
            <div class="amount-box" style="background: linear-gradient(135deg, #ede9fe 0%, #ddd6fe 100%);">
                <div class="amount-label" style="color: #6d28d9;">Montant total TTC</div>
                <div class="amount-value" style="color: #5b21b6;">${amountStr}</div>
            </div>
            
	            <div class="alert alert-info">
	                <span class="alert-icon">⏰</span>
	                <div>Ce devis est valable jusqu'au <strong>${validUntilStr}</strong>. Passé ce délai, les conditions pourront être révisées.</div>
	            </div>
	            
	            <p class="message">
	                Vous trouverez également ce devis en pièce jointe au format PDF.
	            </p>
	            
	            ${signatureUrl ? `
	            <div class="cta-container">
	                <a href="${signatureUrl}" class="btn btn-success">Signer ce devis en toute sécurité</a>
	            </div>
            <p style="text-align: center; color: #6b7280; font-size: 13px;">
                Cliquez sur le bouton pour consulter ce devis et lancer la signature électronique sécurisée
            </p>
            ` : ''}
            ${data.termsUrl ? `
            <p style="text-align: center; margin-top: 16px;">
                <a href="${data.termsUrl}" style="color: #2563eb; text-decoration: none;">Lire les CGV associées à ce devis →</a>
            </p>
            ` : ''}
	            
	            <div class="divider"></div>
	            
	            <div class="signature">
	                <p>N'hésitez pas à nous contacter pour toute question.</p>
	                <p>Cordialement,</p>
                <p class="signature-name">${data.companyName}</p>
            </div>
        </div>
        
        ${generateFooter(data)}
    `;
    
    const text = `
${data.companyName}

DEVIS N° ${data.quoteNumber}

Bonjour ${data.clientName},

Suite à votre demande, nous avons le plaisir de vous transmettre notre devis.
${data.subject ? `\nObjet : ${data.subject}` : ''}

DÉTAILS DU DEVIS :
- Numéro : ${data.quoteNumber}
${issueDateStr ? `- Date d'émission : ${issueDateStr}` : ''}
- Valide jusqu'au : ${validUntilStr}
- Montant TTC : ${amountStr}

Ce devis est valable jusqu'au ${validUntilStr}.

${signatureUrl ? `Pour consulter et signer électroniquement ce devis : ${signatureUrl}` : ''}
${data.termsUrl ? `Lire les CGV associées à ce devis : ${data.termsUrl}` : ''}

N'hésitez pas à nous contacter pour toute question.

Cordialement,
${data.companyName}
    `;
    
    return { subject, html: wrapTemplate(content), text: appendGeneratedBySenedText(text) };
}

/**
 * Email de rappel - Le devis va expirer
 */
export function quoteExpiringEmail(data: QuoteEmailData): { subject: string; html: string; text: string } {
    const days = data.daysUntilExpiry || data.daysRemaining || 0;
    const daysText = days === 1 ? 'demain' : `dans ${days} jours`;
    const subject = `⚠️ Votre devis ${data.quoteNumber} expire ${daysText}`;
    const amountStr = formatAmount(data.amount);
    const validUntilStr = data.validUntil ? formatDate(data.validUntil) : '';
    const signatureUrl = data.signUrl || data.signatureUrl;
    
    const content = `
        <div class="header" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);">
            ${renderEmailHeaderLogo(data)}
            <h1 class="header-title">Devis en cours d'expiration</h1>
            <p class="header-subtitle">N° ${data.quoteNumber}</p>
        </div>
        
        <div class="content">
            <p class="greeting">Bonjour <strong>${data.clientName}</strong>,</p>
            
            <div class="alert alert-warning">
                <span class="alert-icon">⏳</span>
                <div>Votre devis <strong>${data.quoteNumber}</strong> expire <strong>${daysText}</strong> (le ${validUntilStr}).</div>
            </div>
            
            <p class="message">
                Nous vous rappelons que vous avez reçu un devis de notre part qui n'a pas encore été validé.
                Si vous êtes toujours intéressé, nous vous invitons à l'accepter avant son expiration.
            </p>
            
            <div class="amount-box" style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);">
                <div class="amount-label" style="color: #92400e;">Montant du devis</div>
                <div class="amount-value" style="color: #b45309;">${amountStr}</div>
            </div>
            
            ${signatureUrl ? `
            <div class="cta-container">
                <a href="${signatureUrl}" class="btn btn-warning">Accepter avant expiration</a>
            </div>
            ` : ''}
            
            <div class="divider"></div>
            
            <div class="signature">
                <p>Pour toute question ou demande de prolongation, n'hésitez pas à nous contacter.</p>
                <p>Cordialement,</p>
                <p class="signature-name">${data.companyName}</p>
            </div>
        </div>
        
        ${generateFooter(data)}
    `;
    
    const text = `
${data.companyName}

⚠️ RAPPEL - DEVIS N° ${data.quoteNumber}

Bonjour ${data.clientName},

Votre devis ${data.quoteNumber} expire ${daysText} (le ${validUntilStr}).

Si vous êtes toujours intéressé, nous vous invitons à l'accepter avant son expiration.

Montant : ${amountStr}

${signatureUrl ? `Pour accepter : ${signatureUrl}` : ''}

Pour toute question ou demande de prolongation, n'hésitez pas à nous contacter.

Cordialement,
${data.companyName}
    `;
    
    return { subject, html: wrapTemplate(content), text: appendGeneratedBySenedText(text) };
}

/**
 * Email de confirmation - Devis accepté
 */
export function quoteAcceptedEmail(data: QuoteEmailData): { subject: string; html: string; text: string } {
    const subject = `✅ Devis ${data.quoteNumber} accepté - Merci !`;
    const amountStr = formatAmount(data.amount);
    const acceptedDateStr = data.acceptedDate ? formatDate(data.acceptedDate) : '';
    
    const content = `
        <div class="header" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
            ${renderEmailHeaderLogo(data)}
            <h1 class="header-title">Devis Accepté !</h1>
            <p class="header-subtitle">Merci pour votre confiance</p>
        </div>
        
        <div class="content">
            <p class="greeting">Bonjour <strong>${data.clientName}</strong>,</p>
            
            <div class="alert alert-success">
                <span class="alert-icon">✓</span>
                <div>Votre acceptation du devis <strong>${data.quoteNumber}</strong> a bien été enregistrée${acceptedDateStr ? ` le ${acceptedDateStr}` : ''}.</div>
            </div>
            
            <p class="message">
                Nous vous remercions pour votre confiance. Votre commande est en cours de traitement 
                et nous vous contacterons prochainement pour organiser la suite.
            </p>
            
            <div class="info-card">
                <div class="info-row">
                    <span class="info-label">Numéro de devis :</span>
                    <span class="info-value">${data.quoteNumber}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Montant accepté :</span>
                    <span class="info-value" style="color: #059669;">${amountStr}</span>
                </div>
            </div>
	            
	            <p class="message">
	                Une facture vous sera transmise prochainement.
	            </p>
            
            <div class="divider"></div>
            
            <div class="signature">
                <p>À très bientôt !</p>
                <p class="signature-name">${data.companyName}</p>
            </div>
        </div>
        
        ${generateFooter(data)}
    `;
    
    const text = `
${data.companyName}

✅ DEVIS ACCEPTÉ - N° ${data.quoteNumber}

Bonjour ${data.clientName},

Votre acceptation du devis ${data.quoteNumber} a bien été enregistrée${acceptedDateStr ? ` le ${acceptedDateStr}` : ''}.

Nous vous remercions pour votre confiance. Votre commande est en cours de traitement.

Montant : ${amountStr}

	Une facture vous sera transmise prochainement.

À très bientôt !
${data.companyName}
    `;
    
    return { subject, html: wrapTemplate(content), text: appendGeneratedBySenedText(text) };
}

/**
 * Email de notification - Devis refusé
 */
export function quoteRefusedEmail(data: QuoteEmailData): { subject: string; html: string; text: string } {
    const subject = `Devis ${data.quoteNumber} - Nous avons bien noté votre réponse`;
    const refuseReason = data.refuseReason || data.reason;
    const refusedDateStr = data.refusedDate ? formatDate(data.refusedDate) : '';
    
    const content = `
        <div class="header" style="background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);">
            ${renderEmailHeaderLogo(data)}
            <h1 class="header-title">Devis non retenu</h1>
            <p class="header-subtitle">N° ${data.quoteNumber}</p>
        </div>
        
        <div class="content">
            <p class="greeting">Bonjour <strong>${data.clientName}</strong>,</p>
            
            <p class="message">
                Nous avons bien pris en compte votre décision concernant le devis <strong>${data.quoteNumber}</strong>${refusedDateStr ? ` le ${refusedDateStr}` : ''}.
            </p>
            
            ${refuseReason ? `
            <div class="info-card">
                <div class="info-label" style="margin-bottom: 8px;">Motif indiqué :</div>
                <div style="color: #374151; font-style: italic;">"${refuseReason}"</div>
            </div>
            ` : ''}
            
            <p class="message">
                Nous restons à votre disposition pour tout nouveau projet ou si vous souhaitez 
                discuter d'une nouvelle proposition.
            </p>
            
            <div class="divider"></div>
            
            <div class="signature">
                <p>Cordialement,</p>
                <p class="signature-name">${data.companyName}</p>
            </div>
        </div>
        
        ${generateFooter(data)}
    `;
    
    const text = `
${data.companyName}

DEVIS NON RETENU - N° ${data.quoteNumber}

Bonjour ${data.clientName},

Nous avons bien pris en compte votre décision concernant le devis ${data.quoteNumber}${refusedDateStr ? ` le ${refusedDateStr}` : ''}.

${refuseReason ? `Motif : "${refuseReason}"` : ''}

Nous restons à votre disposition pour tout nouveau projet.

Cordialement,
${data.companyName}
    `;
    
    return { subject, html: wrapTemplate(content), text: appendGeneratedBySenedText(text) };
}
