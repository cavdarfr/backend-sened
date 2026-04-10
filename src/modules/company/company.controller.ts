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
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { CompanyService } from "./company.service";
import {
  CreateCompanyDto,
  UpdateCompanyDto,
  CompanyQueryDto,
  CompanyWithRoleResponseDto,
  CompanyListResponseDto,
  SetDefaultCompanyDto,
  UpdateCompanyGeneralDto,
  UpdateCompanyContactDto,
  UpdateCompanyBankingDto,
  UpdateCompanySettingsDto,
  LinkAccountantDto,
  CreateAccountantLinkRequestDto,
  AccountantLinkRequestsQueryDto,
  AccountantLinkRequestResponseDto,
  InviteMemberDto,
  InviteLinkedClientMerchantAdminDto,
  InviteNewMerchantAdminDto,
  InviteAccountantFirmDto,
  AccountantDocumentsQueryDto,
  BulkDownloadLinkedClientDocumentsDto,
} from "./dto/company.dto";
import { SupabaseAuthGuard } from "../../common/guards/supabase-auth.guard";
import { SubscriptionGuard } from "../../common/guards/subscription.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";

/**
 * Contrôleur pour la gestion des entreprises
 * Fournit les endpoints CRUD pour les entreprises
 *
 * Routes disponibles:
 * - POST   /api/companies           - Créer une entreprise
 * - GET    /api/companies           - Liste des entreprises de l'utilisateur
 * - GET    /api/companies/default   - Récupérer l'entreprise par défaut
 * - GET    /api/companies/:id       - Récupérer une entreprise par ID
 * - PUT    /api/companies/:id       - Mettre à jour une entreprise (complet)
 * - PUT    /api/companies/:id/general  - Mettre à jour les informations générales
 * - PUT    /api/companies/:id/contact  - Mettre à jour les coordonnées
 * - PUT    /api/companies/:id/banking  - Mettre à jour les informations bancaires
 * - PUT    /api/companies/:id/settings - Mettre à jour les paramètres
 * - DELETE /api/companies/:id       - Supprimer une entreprise
 * - POST   /api/companies/:id/set-default - Définir comme entreprise par défaut
 */
@Controller("companies")
@UseGuards(SupabaseAuthGuard)
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  /**
   * Crée une nouvelle entreprise
   * L'utilisateur connecté devient automatiquement admin de cette entreprise
   *
   * @param userId - ID de l'utilisateur authentifié
   * @param createCompanyDto - Données de création de l'entreprise
   * @returns L'entreprise créée avec le rôle de l'utilisateur
   */
  @Post()
  @UseGuards(SubscriptionGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser("id") userId: string,
    @Body() createCompanyDto: CreateCompanyDto,
  ): Promise<CompanyWithRoleResponseDto> {
    return this.companyService.create(userId, createCompanyDto);
  }

  /**
   * Récupère la liste des entreprises de l'utilisateur
   * Supporte la pagination et la recherche
   *
   * @param userId - ID de l'utilisateur authentifié
   * @param query - Paramètres de recherche et pagination
   * @returns Liste paginée des entreprises
   */
  @Get()
  async findAll(
    @CurrentUser("id") userId: string,
    @Query() query: CompanyQueryDto,
  ): Promise<CompanyListResponseDto> {
    return this.companyService.findAll(userId, query);
  }

  /**
   * Récupère l'entreprise par défaut de l'utilisateur
   *
   * @param userId - ID de l'utilisateur authentifié
   * @returns L'entreprise par défaut ou null
   */
  @Get("default")
  async getDefault(
    @CurrentUser("id") userId: string,
  ): Promise<CompanyWithRoleResponseDto | null> {
    return this.companyService.getDefault(userId);
  }

  /**
   * Recherche des cabinets comptables inscrits sur la plateforme
   */
  @Get("search-accountants")
  async searchAccountants(
    @Query("q") query: string,
  ): Promise<{ id: string; name: string; siren: string | null }[]> {
    return this.companyService.searchAccountants(query);
  }

  @Get(":id/search-merchants")
  async searchMerchants(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("q") query: string,
  ): Promise<
    {
      id: string;
      name: string;
      legal_name: string | null;
      siren: string | null;
      city: string | null;
      logo_url: string | null;
    }[]
  > {
    return this.companyService.searchMerchants(userId, id, query);
  }

  /**
   * Récupère une entreprise par son ID
   * L'utilisateur doit avoir accès à cette entreprise
   *
   * @param userId - ID de l'utilisateur authentifié
   * @param id - ID de l'entreprise
   * @returns L'entreprise avec le rôle de l'utilisateur
   */
  @Get(":id")
  async findOne(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CompanyWithRoleResponseDto> {
    return this.companyService.findOne(userId, id);
  }

  /**
   * Met à jour une entreprise
   * Seuls les administrateurs de l'entreprise peuvent la modifier
   *
   * @param userId - ID de l'utilisateur authentifié
   * @param id - ID de l'entreprise
   * @param updateCompanyDto - Données de mise à jour
   * @returns L'entreprise mise à jour
   */
  @Put(":id")
  @UseGuards(SubscriptionGuard)
  async update(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateCompanyDto: UpdateCompanyDto,
  ): Promise<CompanyWithRoleResponseDto> {
    return this.companyService.update(userId, id, updateCompanyDto);
  }

  /**
   * Supprime une entreprise
   * Seuls les administrateurs peuvent supprimer une entreprise
   * L'utilisateur doit avoir au moins une autre entreprise
   * L'entreprise ne doit pas contenir de devis ou factures
   *
   * @param userId - ID de l'utilisateur authentifié
   * @param id - ID de l'entreprise
   * @returns Message de confirmation
   */
  @Delete(":id")
  @UseGuards(SubscriptionGuard)
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ message: string }> {
    return this.companyService.remove(userId, id);
  }

  /**
   * Définit une entreprise comme entreprise par défaut
   *
   * @param userId - ID de l'utilisateur authentifié
   * @param id - ID de l'entreprise
   * @returns L'entreprise mise à jour
   */
  @Post(":id/set-default")
  @HttpCode(HttpStatus.OK)
  async setDefault(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CompanyWithRoleResponseDto> {
    return this.companyService.setDefault(userId, id);
  }

  // ============================================
  // Endpoints de mise à jour par section
  // ============================================

  /**
   * Met à jour les informations générales d'une entreprise
   * Section: Général (name, legal_name, siret, vat_number)
   * Seuls les administrateurs peuvent modifier
   *
   * @param userId - ID de l'utilisateur authentifié
   * @param id - ID de l'entreprise
   * @param updateDto - Données de mise à jour
   * @returns L'entreprise mise à jour
   */
  @Put(":id/general")
  @UseGuards(SubscriptionGuard)
  async updateGeneral(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateCompanyGeneralDto,
  ): Promise<CompanyWithRoleResponseDto> {
    return this.companyService.updateGeneral(userId, id, updateDto);
  }

  /**
   * Met à jour les coordonnées d'une entreprise
   * Section: Contact (email, phone, website, address, city, postal_code, country)
   * Seuls les administrateurs peuvent modifier
   *
   * @param userId - ID de l'utilisateur authentifié
   * @param id - ID de l'entreprise
   * @param updateDto - Données de mise à jour
   * @returns L'entreprise mise à jour
   */
  @Put(":id/contact")
  @UseGuards(SubscriptionGuard)
  async updateContact(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateCompanyContactDto,
  ): Promise<CompanyWithRoleResponseDto> {
    return this.companyService.updateContact(userId, id, updateDto);
  }

  /**
   * Met à jour les informations bancaires d'une entreprise
   * Section: Bancaire (rib_iban, rib_bic, rib_bank_name)
   * Seuls les administrateurs peuvent modifier
   *
   * @param userId - ID de l'utilisateur authentifié
   * @param id - ID de l'entreprise
   * @param updateDto - Données de mise à jour
   * @returns L'entreprise mise à jour
   */
  @Put(":id/banking")
  @UseGuards(SubscriptionGuard)
  async updateBanking(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateCompanyBankingDto,
  ): Promise<CompanyWithRoleResponseDto> {
    return this.companyService.updateBanking(userId, id, updateDto);
  }

  /**
   * Met à jour les paramètres d'une entreprise
   * Section: Paramètres (default_vat_rate, default_payment_terms, quote_validity_days, etc.)
   * Seuls les administrateurs peuvent modifier
   *
   * @param userId - ID de l'utilisateur authentifié
   * @param id - ID de l'entreprise
   * @param updateDto - Données de mise à jour
   * @returns L'entreprise mise à jour
   */
  @Put(":id/settings")
  @UseGuards(SubscriptionGuard)
  async updateSettings(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateCompanySettingsDto,
  ): Promise<CompanyWithRoleResponseDto> {
    return this.companyService.updateSettings(userId, id, updateDto);
  }

  // ============================================
  // Accountant linking
  // ============================================

  @Post(":id/link-accountant")
  @HttpCode(HttpStatus.OK)
  async linkAccountant(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: LinkAccountantDto,
  ): Promise<CompanyWithRoleResponseDto> {
    return this.companyService.linkAccountant(
      userId,
      id,
      dto.accountant_company_id,
    );
  }

  @Post(":id/invite-accountant-firm")
  @HttpCode(HttpStatus.CREATED)
  async inviteAccountantFirm(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: InviteAccountantFirmDto,
  ) {
    return this.companyService.inviteAccountantFirm(userId, id, dto);
  }

  @Delete(":id/link-accountant")
  @HttpCode(HttpStatus.OK)
  async unlinkAccountant(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CompanyWithRoleResponseDto> {
    return this.companyService.unlinkAccountant(userId, id);
  }

  @Get(":id/linked-clients")
  async getLinkedClients(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.companyService.getLinkedClients(userId, id);
  }

  @Post(":id/invite-new-merchant-admin")
  @HttpCode(HttpStatus.CREATED)
  async inviteNewMerchantAdmin(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: InviteNewMerchantAdminDto,
  ) {
    return this.companyService.inviteNewMerchantAdmin(userId, id, dto);
  }

  @Get(":id/accountant-link-requests")
  async getAccountantLinkRequests(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: AccountantLinkRequestsQueryDto,
  ): Promise<AccountantLinkRequestResponseDto[]> {
    return this.companyService.getAccountantLinkRequests(
      userId,
      id,
      query.direction || "incoming",
    );
  }

  @Post(":id/accountant-link-requests")
  @HttpCode(HttpStatus.CREATED)
  async createAccountantLinkRequest(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateAccountantLinkRequestDto,
  ): Promise<AccountantLinkRequestResponseDto> {
    return this.companyService.createAccountantLinkRequest(
      userId,
      id,
      dto.merchant_company_id,
    );
  }

  @Post(":id/accountant-link-requests/:requestId/accept")
  async acceptAccountantLinkRequest(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("requestId", ParseUUIDPipe) requestId: string,
  ): Promise<AccountantLinkRequestResponseDto> {
    return this.companyService.acceptAccountantLinkRequest(
      userId,
      id,
      requestId,
    );
  }

  @Post(":id/accountant-link-requests/:requestId/reject")
  async rejectAccountantLinkRequest(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("requestId", ParseUUIDPipe) requestId: string,
  ): Promise<AccountantLinkRequestResponseDto> {
    return this.companyService.rejectAccountantLinkRequest(
      userId,
      id,
      requestId,
    );
  }

  @Get(":id/linked-clients/:clientId/merchant-admin-invitations")
  async getLinkedClientMerchantAdminInvitations(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("clientId", ParseUUIDPipe) clientId: string,
  ) {
    return this.companyService.getLinkedClientMerchantAdminInvitations(
      userId,
      id,
      clientId,
    );
  }

  @Post(":id/linked-clients/:clientId/invite-merchant-admin")
  @HttpCode(HttpStatus.CREATED)
  async inviteLinkedClientMerchantAdmin(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("clientId", ParseUUIDPipe) clientId: string,
    @Body() dto: InviteLinkedClientMerchantAdminDto,
  ) {
    return this.companyService.inviteLinkedClientMerchantAdmin(
      userId,
      id,
      clientId,
      dto.email,
    );
  }

  @Delete(
    ":id/linked-clients/:clientId/merchant-admin-invitations/:invitationId",
  )
  @HttpCode(HttpStatus.OK)
  async cancelLinkedClientMerchantAdminInvitation(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("clientId", ParseUUIDPipe) clientId: string,
    @Param("invitationId", ParseUUIDPipe) invitationId: string,
  ) {
    return this.companyService.cancelLinkedClientMerchantAdminInvitation(
      userId,
      id,
      clientId,
      invitationId,
    );
  }

  @Get(":id/linked-clients/:clientId/documents")
  async getLinkedClientDocuments(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("clientId", ParseUUIDPipe) clientId: string,
    @Query() query: AccountantDocumentsQueryDto,
  ): Promise<any> {
    return this.companyService.getLinkedClientDocuments(
      userId,
      id,
      clientId,
      query,
    );
  }

  @Post(":id/linked-clients/:clientId/documents/download-zip")
  async downloadLinkedClientDocumentsZip(
    @CurrentUser("id") userId: string,
    @Res() res: Response,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("clientId", ParseUUIDPipe) clientId: string,
    @Body() body: BulkDownloadLinkedClientDocumentsDto,
  ) {
    await this.companyService.downloadLinkedClientDocumentsZip(
      userId,
      res,
      id,
      clientId,
      body,
    );
  }

  @Get(":id/linked-clients/:clientId/documents/:documentId/download")
  async downloadLinkedClientDocument(
    @CurrentUser("id") userId: string,
    @Res() res: Response,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("clientId", ParseUUIDPipe) clientId: string,
    @Param("documentId", ParseUUIDPipe) documentId: string,
  ) {
    const document = await this.companyService.downloadLinkedClientDocument(
      userId,
      id,
      clientId,
      documentId,
    );

    res.set({
      "Content-Type": document.mimeType,
      "Content-Disposition": `attachment; filename="${document.filename}"`,
      "Content-Length": document.buffer.length,
    });

    res.send(document.buffer);
  }

  // ============================================
  // Member management
  // ============================================

  @Get(":id/members")
  async getMembers(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.companyService.getMembers(userId, id);
  }

  @Post(":id/members")
  @HttpCode(HttpStatus.CREATED)
  async inviteMember(
    @CurrentUser("id") userId: string,
    @CurrentUser("email") inviterEmail: string | undefined,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: InviteMemberDto,
  ) {
    return this.companyService.inviteMember(
      userId,
      id,
      dto.email,
      dto.role as any,
      inviterEmail,
    );
  }

  @Delete(":id/members/:memberId")
  @HttpCode(HttpStatus.OK)
  async removeMember(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("memberId", ParseUUIDPipe) memberId: string,
  ) {
    return this.companyService.removeMember(userId, id, memberId);
  }

  @Delete(":id/invitations/:invitationId")
  @HttpCode(HttpStatus.OK)
  async cancelInvitation(
    @CurrentUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("invitationId", ParseUUIDPipe) invitationId: string,
  ) {
    return this.companyService.cancelInvitation(userId, id, invitationId);
  }
}
