/* istanbul ignore file */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Redirect,
  Res,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { AuthService } from './auth.service';

import { AuthSignInDto } from './dto/authSignIn.dto';
import { AuthSignUpDto } from './dto/authSignUp.dto';
import { AuthResendCodeDto } from './dto/authResendCode.dto';
import { AuthInviteUserDto } from './dto/authInviteUser.dto';
import { AuthVerifyCodeDto } from './dto/authVerifyCode.dto';
import { AuthinvitedUserSignupDto } from './dto/invitedUserSignup.dto';
import { AuthGetInviteDto } from './dto/authGetInvite.dto';

import { AuthGuard } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';
import { USER } from '@prisma/client';
import { AuthUpdatePasswordDto } from './dto/authSetPassword.dto';
import { UserService } from '../user/user.service';
import { auditRequestContext } from '../user-audit/user-audit.service';

/*
    1.User is redirected to workOs for authentication.
    2.User login/register with the SSO chosed
    3.WorkOs redirects back to our backedn with a code.
    4.I use code to get user profile from Workos.
*/

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly user: UserService,
  ) {}

  @Post('signin')
  @HttpCode(200)
  @ApiBody({ type: AuthSignInDto })
  @ApiOperation({ summary: 'SignIn from our own database' })
  @ApiResponse({ status: 200, description: 'User authenticated successfully' })
  @ApiResponse({ status: 401, description: 'User not found with this email' })
  @ApiResponse({
    status: 401,
    description:
      'User does not use this authentication method. You need to Sign in with the first method you have used',
  })
  @ApiResponse({ status: 401, description: 'User not verified' })
  @ApiResponse({
    status: 401,
    description:
      'User account is inactive, suspended, deleted, or pending verification',
  })
  @ApiResponse({ status: 400, description: 'Invalid Password' })
  @ApiResponse({ status: 400, description: 'Failed to create session' })
  @ApiResponse({ status: 500, description: 'Authentication failed' })
  async signIn(@Body() data: AuthSignInDto, @Req() req: Request) {
    return await this.authService.signIn(data, auditRequestContext(req));
  }

  @Post('signup')
  @HttpCode(201)
  @ApiBody({ type: AuthSignUpDto })
  @ApiOperation({ summary: 'SignUp from our own database' })
  @ApiResponse({
    status: 400,
    description: 'User already exists with this email',
  })
  @ApiResponse({
    status: 400,
    description: 'Failed to generate verification code',
  })
  @ApiResponse({
    status: 400,
    description: 'Failed to store verification code',
  })
  @ApiResponse({ status: 201, description: 'Code sent successfully' })
  async signUp(@Body() data: AuthSignUpDto) {
    const result = await this.authService.signUp(data);
    return {
      statusCode: 201,
      message: 'Code sent successfully',
      token: result.token,
    };
  }

  @Post('verify-code')
  @HttpCode(200)
  @ApiBody({ type: AuthVerifyCodeDto })
  @ApiOperation({ summary: 'Verify code for user registration' })
  @ApiResponse({ status: 302, description: 'User registered successfully' })
  @ApiResponse({ status: 400, description: 'Failed to verify code' })
  @ApiResponse({ status: 400, description: 'Code and token are required' })
  @ApiResponse({ status: 401, description: 'Invalid token' })
  @ApiResponse({ status: 400, description: 'User not found' })
  @ApiResponse({ status: 400, description: 'Invalid verification code' })
  @ApiResponse({ status: 400, description: 'Code already verified' })
  async verifyCode(@Body() data: AuthVerifyCodeDto) {
    const result = await this.authService.verifyCode(data);
    if (!result) {
      return {
        statusCode: 400,
        message: 'Failed to verify code',
      };
    }
    return {
      statusCode: 200,
      message: 'Code verified and User logged in successfully',
      token: result,
    };
  }

  @Post('resend-code')
  @HttpCode(200)
  @ApiBody({ type: AuthResendCodeDto })
  @ApiOperation({ summary: 'Resend verification code to user email' })
  @ApiResponse({ status: 200, description: 'Code sent successfully' })
  @ApiResponse({ status: 400, description: 'Email is required' })
  @ApiResponse({ status: 400, description: 'User not found with this email' })
  @ApiResponse({
    status: 400,
    description: 'Failed to invalidate previous verification code',
  })
  @ApiResponse({
    status: 400,
    description: 'Failed to generate verification code',
  })
  @ApiResponse({
    status: 400,
    description: 'Failed to store verification code',
  })
  @ApiResponse({
    status: 400,
    description: 'Failed to send verification email',
  })
  async resendCode(@Body() data: AuthResendCodeDto) {
    const result = await this.authService.resendCode(data);
    return {
      statusCode: 200,
      message: 'Code sent successfully',
      token: result.token,
    };
  }

  @Post('logout')
  @HttpCode(302)
  @UseGuards(AuthGuard)
  @Redirect()
  @ApiOperation({ summary: 'Logout user' })
  @ApiResponse({ status: 302, description: 'User logged out successfully' })
  @ApiResponse({ status: 400, description: 'Failed to revoke token' })
  @ApiResponse({ status: 500, description: 'Failed to log out user' })
  async logout(@CurrentUser() user: USER) {
    const result = await this.authService.logout(user.id);
    if (result) {
      return {
        statusCode: 302,
        message: 'User logged out successfully',
        url: '/login',
      };
    } else {
      return {
        statusCode: 500,
        message: 'Failed to log out user',
      };
    }
  }

  @Post('invite')
  @HttpCode(201)
  @ApiBody({ type: AuthInviteUserDto })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin', 'organization_super_admin')
  @ApiOperation({ summary: 'An admin invites a new user to the platform' })
  @ApiResponse({
    status: 201,
    description: 'Invitation sent successfully to new.user@client.com.',
  })
  @ApiResponse({ status: 400, description: 'Organization Id not provided' })
  @ApiResponse({ status: 400, description: 'Failed to generate invite code' })
  @ApiResponse({ status: 400, description: 'Failed to send invitation email' })
  @ApiResponse({ status: 400, description: 'Failed to store invite code' })
  @ApiResponse({ status: 409, description: 'User already exists' })
  @ApiResponse({
    status: 403,
    description: 'Access denied: insufficient permissions',
  })
  async inviteUser(
    @Body() data: AuthInviteUserDto,
    @CurrentUser() currentUser: USER,
  ) {
    const result = await this.authService.inviteUser(data, currentUser);
    if (result) {
      return {
        statusCode: 201,
        message: result,
      };
    }
  }

  @Get('re-invite/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin', 'organization_super_admin')
  @ApiOperation({ summary: 'Resend invitation to an invited user' })
  @ApiResponse({
    status: 200,
    description: 'Invitation resent successfully to new.user@client.com.',
  })
  @ApiResponse({ status: 400, description: 'User ID is required' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 400, description: 'Failed to generate invite code' })
  @ApiResponse({ status: 400, description: 'Failed to send invitation email' })
  @ApiResponse({ status: 400, description: 'Failed to store invite code' })
  async reInviteUser(
    @Param('id') id: string,
    @CurrentUser() currentUser: USER,
  ) {
    const result = await this.authService.reInviteUser(id, currentUser);
    if (result) {
      return {
        statusCode: 200,
        message: result,
      };
    }
  }

  @Post('get-user')
  @HttpCode(200)
  @ApiBody({ type: AuthGetInviteDto })
  @ApiOperation({ summary: 'Get user data from email' })
  @ApiResponse({ status: 200, description: 'User data retrieved successfully' })
  @ApiResponse({ status: 400, description: 'Token is required' })
  @ApiResponse({ status: 400, description: 'Invalid Token' })
  @ApiResponse({ status: 404, description: 'Token not found' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getInvite(@Body() data: AuthGetInviteDto): Promise<any> {
    const user = await this.authService.getUser(data);
    return user;
  }

  @Post('invited-user-signup')
  @HttpCode(200)
  @ApiBody({ type: AuthinvitedUserSignupDto })
  @ApiOperation({
    summary: 'Allows a new uset to set their password using a valid invitation',
  })
  @ApiResponse({
    status: 200,
    description: 'Password has been set successfully. You can now log in.',
  })
  @ApiResponse({ status: 400, description: 'Invalid token' })
  @ApiResponse({ status: 404, description: 'Token not found' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 400, description: 'Error in set user password' })
  async invitedUserSignup(@Body() data: AuthinvitedUserSignupDto) {
    const result = await this.authService.invitedUserSignup(data);
    return {
      statusCode: 200,
      message: 'Password has been set successfully. You can now log in.',
      result: result,
    };
  }

  @Patch('update-password')
  @HttpCode(200)
  @ApiBody({ type: AuthUpdatePasswordDto })
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Allows a user to set their password' })
  @ApiResponse({
    status: 200,
    description: 'Password has been set successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Old password and new password are required',
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 400, description: 'Invalid old password' })
  async updatePassword(
    @Body() data: AuthUpdatePasswordDto,
    @CurrentUser() user: USER,
  ) {
    const result = await this.authService.updatePassword(data, user);
    return {
      statusCode: 200,
      message: 'Password has been set successfully',
      result: result,
    };
  }
}
