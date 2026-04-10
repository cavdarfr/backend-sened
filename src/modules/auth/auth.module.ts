import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SubscriptionModule } from '../subscription/subscription.module';
import { CompanyModule } from '../company/company.module';

/**
 * Module d'authentification
 * Gère la vérification des tokens et les opérations d'authentification
 */
@Module({
    imports: [SubscriptionModule, CompanyModule],
    controllers: [AuthController],
    providers: [AuthService],
    exports: [AuthService],
})
export class AuthModule { }
