import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Query,
    UseGuards,
    ParseUUIDPipe,
    HttpCode,
    HttpStatus,
    Req,
    Res,
    Headers,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QuoteService } from './quote.service';
import { PdfService } from '../pdf/pdf.service';
import {
    CreateQuoteDto,
    UpdateQuoteDto,
    QuoteQueryDto,
    SendQuoteDto,
    SignQuoteDto,
    RefuseQuoteDto,
    Quote,
    PublicQuote,
    PublicQuoteTerms,
    QuoteListResponse,
    SendQuoteResponse,
    QuoteSignatureDocument,
} from './dto/quote.dto';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { QuotaGuard } from '../../common/guards/quota.guard';
import { CheckQuota } from '../../common/decorators/check-quota.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * Contrôleur pour la gestion des devis
 * 
 * Routes protégées (authentification requise):
 * - POST   /api/companies/:companyId/quotes           - Créer un devis
 * - GET    /api/companies/:companyId/quotes           - Liste des devis
 * - GET    /api/companies/:companyId/quotes/:id       - Détails d'un devis
 * - PUT    /api/companies/:companyId/quotes/:id       - Modifier un devis
 * - DELETE /api/companies/:companyId/quotes/:id       - Supprimer un devis
 * - POST   /api/companies/:companyId/quotes/:id/send  - Envoyer un devis
 * - POST   /api/companies/:companyId/quotes/:id/duplicate - Dupliquer un devis
 * - POST   /api/companies/:companyId/quotes/:id/convert - Convertir en facture
 * - GET    /api/companies/:companyId/quotes/:id/pdf   - Télécharger le PDF
 * 
 * Routes publiques (accès via token):
 * - GET    /api/quotes/sign/:token                    - Voir un devis via token
 * - POST   /api/quotes/sign/:token                    - Signer un devis
 * - POST   /api/quotes/refuse/:token                  - Refuser un devis
 * - GET    /api/quotes/pdf/:token                     - Télécharger le PDF via token
 */
@Controller()
export class QuoteController {
    constructor(
        private readonly quoteService: QuoteService,
        private readonly pdfService: PdfService,
    ) {}

    // ==========================================
    // ROUTES PROTÉGÉES (Authentification requise)
    // ==========================================

    /**
     * Crée un nouveau devis
     */
    @Post('companies/:companyId/quotes')
    @UseGuards(SupabaseAuthGuard, SubscriptionGuard, QuotaGuard)
    @CheckQuota('max_quotes_per_month')
    @HttpCode(HttpStatus.CREATED)
    async create(
        @CurrentUser('id') userId: string,
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Body() createQuoteDto: CreateQuoteDto,
    ): Promise<Quote> {
        return this.quoteService.create(userId, companyId, createQuoteDto);
    }

    /**
     * Récupère la liste des devis d'une entreprise
     */
    @Get('companies/:companyId/quotes')
    @UseGuards(SupabaseAuthGuard)
    async findAll(
        @CurrentUser('id') userId: string,
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Query() query: QuoteQueryDto,
    ): Promise<QuoteListResponse> {
        return this.quoteService.findAll(userId, companyId, query);
    }

    /**
     * Récupère un devis par son ID
     */
    @Get('companies/:companyId/quotes/:id')
    @UseGuards(SupabaseAuthGuard)
    async findOne(
        @CurrentUser('id') userId: string,
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<Quote> {
        return this.quoteService.findOne(userId, companyId, id);
    }

    /**
     * Met à jour un devis
     */
    @Put('companies/:companyId/quotes/:id')
    @UseGuards(SupabaseAuthGuard, SubscriptionGuard)
    async update(
        @CurrentUser('id') userId: string,
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() updateQuoteDto: UpdateQuoteDto,
    ): Promise<Quote> {
        return this.quoteService.update(userId, companyId, id, updateQuoteDto);
    }

    /**
     * Supprime un devis
     */
    @Delete('companies/:companyId/quotes/:id')
    @UseGuards(SupabaseAuthGuard, SubscriptionGuard)
    @HttpCode(HttpStatus.NO_CONTENT)
    async delete(
        @CurrentUser('id') userId: string,
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        return this.quoteService.delete(userId, companyId, id);
    }

    /**
     * Duplique un devis
     */
    @Post('companies/:companyId/quotes/:id/duplicate')
    @UseGuards(SupabaseAuthGuard, SubscriptionGuard)
    async duplicate(
        @CurrentUser('id') userId: string,
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<Quote> {
        return this.quoteService.duplicate(userId, companyId, id);
    }

    /**
     * Envoie un devis au client
     */
    @Post('companies/:companyId/quotes/:id/send')
    @UseGuards(SupabaseAuthGuard, SubscriptionGuard)
    async send(
        @CurrentUser('id') userId: string,
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: SendQuoteDto,
    ): Promise<SendQuoteResponse> {
        return this.quoteService.send(userId, companyId, id, dto);
    }

    /**
     * Convertit manuellement un devis en facture
     */
    @Post('companies/:companyId/quotes/:id/convert')
    @UseGuards(SupabaseAuthGuard, SubscriptionGuard)
    async convert(
        @CurrentUser('id') userId: string,
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ invoice_id: string }> {
        const invoiceId = await this.quoteService.convert(userId, companyId, id);
        return { invoice_id: invoiceId };
    }

    @Get('companies/:companyId/quotes/:id/signature-documents')
    @UseGuards(SupabaseAuthGuard)
    async getSignatureDocuments(
        @CurrentUser('id') userId: string,
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<QuoteSignatureDocument[]> {
        return this.quoteService.getSignatureDocuments(userId, companyId, id);
    }

    @Get('companies/:companyId/quotes/:id/signature-documents/:documentId/download')
    @UseGuards(SupabaseAuthGuard)
    async downloadSignatureDocument(
        @CurrentUser('id') userId: string,
        @Res() res: Response,
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('documentId', ParseUUIDPipe) documentId: string,
    ) {
        const document = await this.quoteService.downloadSignatureDocument(userId, companyId, id, documentId);

        res.set({
            'Content-Type': document.mimeType,
            'Content-Disposition': `attachment; filename="${document.filename}"`,
            'Content-Length': document.buffer.length,
        });

        res.send(document.buffer);
    }

    // ==========================================
    // ROUTES PUBLIQUES (Accès via token de signature)
    // ==========================================

    /**
     * Récupère un devis via son token de signature (accès public)
     */
    @Get('quotes/sign/:token')
    async findByToken(
        @Param('token') token: string,
    ): Promise<PublicQuote> {
        return this.quoteService.findBySignatureToken(token);
    }

    /**
     * Récupère les CGV figées associées à un devis via token (accès public)
     */
    @Get('quotes/sign/:token/terms')
    async getTermsByToken(
        @Param('token') token: string,
    ): Promise<PublicQuoteTerms> {
        return this.quoteService.getTermsBySignatureToken(token);
    }

    /**
     * Signe un devis (accès public via token)
     */
    @Post('quotes/sign/:token')
    async sign(
        @Param('token') token: string,
        @Body() signQuoteDto: SignQuoteDto,
        @Req() req: Request,
        @Headers('user-agent') userAgent: string,
    ): Promise<{ quote: PublicQuote; invoice_id: string; message: string }> {
        // Récupérer l'IP du client
        const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || 
                   req.socket.remoteAddress || 
                   '0.0.0.0';

        const result = await this.quoteService.sign(token, signQuoteDto, ip, userAgent || '');
        
        return {
            ...result,
	            message: 'Devis signé avec succès. Une facture a été générée et sera envoyée prochainement.',
        };
    }

    /**
     * Refuse un devis (accès public via token)
     */
    @Post('quotes/refuse/:token')
    async refuse(
        @Param('token') token: string,
        @Body() refuseQuoteDto: RefuseQuoteDto,
    ): Promise<{ quote: PublicQuote; message: string }> {
        const quote = await this.quoteService.refuse(token, refuseQuoteDto);
        
        return {
            quote,
            message: 'Devis refusé.',
        };
    }

    /**
     * Télécharger le PDF d'un devis (protégé)
     */
    @Get('companies/:companyId/quotes/:id/pdf')
    async downloadPdf(
        @Req() req: any,
        @Res() res: Response,
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        const userId = req.user?.id;

        const quote = await this.quoteService.findOne(userId, companyId, id);
        const pdfData = this.quoteService.formatForPdf(quote);
        const pdfBuffer = await this.pdfService.generateQuotePdf(pdfData);

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="devis-${quote.quote_number}.pdf"`,
            'Content-Length': pdfBuffer.length,
        });

        res.send(pdfBuffer);
    }

    /**
     * Télécharger le PDF d'un devis via token (accès public)
     */
    @Get('quotes/pdf/:token')
    async downloadPdfByToken(
        @Res() res: Response,
        @Param('token') token: string,
    ) {
        const quote = await this.quoteService.findBySignatureToken(token);
        const pdfData = this.quoteService.formatForPdf(quote);
        const pdfBuffer = await this.pdfService.generateQuotePdf(pdfData);

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="devis-${quote.quote_number}.pdf"`,
            'Content-Length': pdfBuffer.length,
        });

        res.send(pdfBuffer);
    }
}
