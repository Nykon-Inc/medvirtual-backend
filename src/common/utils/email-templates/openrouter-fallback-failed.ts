import { EmailHeader, EmailFooter } from './components';
import { escapeEmailHtml } from './escape';

/**
 * Sent when a primary AI provider fails AND its fallback also failed, meaning
 * nothing processed the request. Used both when OpenAI is primary (quota
 * exhausted, OpenRouter fallback fails too) and when OpenRouter is primary
 * (any error, OpenAI fallback fails too) — `primaryProvider` picks the copy so
 * the alert always names who failed first. Error text is escaped because
 * provider messages can contain markup that would otherwise break the email
 * body.
 */
export default function openrouterFallbackFailed(
  operation: string,
  error: unknown,
  failedAt: Date,
  primaryProvider: 'openai' | 'openrouter' = 'openai',
) {
  const formatDate = (d: Date) =>
    d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const escapeHtml = escapeEmailHtml;

  // Axios only puts the generic "Request failed with status code N" on
  // `error.message` — the actual reason (e.g. which OpenRouter spend limit
  // was hit) lives in `error.response.data`, so prefer that when present.
  const responseBody = (error as any)?.response?.data;
  const rawErrorMessage = responseBody
    ? (() => {
        try {
          return typeof responseBody === 'string'
            ? responseBody
            : JSON.stringify(responseBody);
        } catch {
          return error instanceof Error ? error.message : String(error);
        }
      })()
    : error instanceof Error
      ? error.message
      : String(error);

  const errorMessage = escapeHtml(rawErrorMessage);

  const errorStack = escapeHtml(
    error instanceof Error && error.stack
      ? error.stack
      : 'No stack trace available',
  );

  const isOpenRouterPrimary = primaryProvider === 'openrouter';
  const failureSummary = isOpenRouterPrimary
    ? `OpenRouter failed and the OpenAI fallback also failed on <strong>${formatDate(failedAt)}</strong>. The operation <strong>${escapeHtml(operation)}</strong> did not complete.`
    : `OpenAI reported <strong>insufficient quota</strong> and the OpenRouter fallback also failed on <strong>${formatDate(failedAt)}</strong>. The operation <strong>${escapeHtml(operation)}</strong> did not complete.`;
  const errorSectionTitle = isOpenRouterPrimary
    ? 'OpenAI Error'
    : 'OpenRouter Error';
  const checklist = isOpenRouterPrimary
    ? `<li>Whether <strong>OPENAI_API_KEY_RESUME_EXTRACTION</strong> / <strong>OPENAI_API_KEY</strong> is still valid and has credit.</li>
        <li>Whether the OpenRouter account still has free-tier requests available for today.</li>
        <li>Whether <strong>OPENROUTER_API_KEY</strong> is still valid.</li>
        <li>Whether the configured models in <strong>OPENROUTER_VISION_MODELS</strong> / <strong>OPENROUTER_TEXT_MODELS</strong> are still available.</li>`
    : `<li>Whether the OpenRouter account still has free-tier requests available for today.</li>
        <li>Whether <strong>OPENROUTER_API_KEY</strong> is still valid.</li>
        <li>Whether the configured models in <strong>OPENROUTER_VISION_MODELS</strong> are still available.</li>
        <li>Restoring OpenAI credits, which removes the dependency on the fallback entirely.</li>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100&display=swap" rel="stylesheet">
  <style>* { font-family: "Be Vietnam Pro", font-style: normal }</style>
  <title>OpenRouter Fallback Failed</title>
</head>
<body style="margin:0;padding:0;width:100%!important;min-width:100%;background-color:#f4f4f4;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="max-width:650px;margin:0 auto;background-color:#ffffff;">
    ${EmailHeader}

    <div style="padding:24px 24px 8px;">
      <div style="background-color:#fdecea;border-left:4px solid #c62828;padding:16px;border-radius:4px;margin-bottom:20px;">
        <p style="color:#c62828;font-size:16px;font-weight:700;margin:0 0 4px;">Both AI providers failed</p>
        <p style="color:#333;font-size:14px;margin:0;">${failureSummary}</p>
      </div>

      <h3 style="color:#181D27;margin-bottom:8px;">${errorSectionTitle}</h3>
      <div style="background-color:#f5f5f5;border:1px solid #ccc;border-radius:4px;padding:14px;margin-bottom:20px;">
        <p style="color:#c62828;font-size:14px;margin:0;word-break:break-word;">${errorMessage}</p>
      </div>

      <h3 style="color:#181D27;margin-bottom:8px;">Stack Trace</h3>
      <div style="background-color:#212121;border-radius:4px;padding:14px;margin-bottom:24px;overflow-x:auto;">
        <pre style="color:#f5f5f5;font-size:12px;margin:0;white-space:pre-wrap;word-break:break-word;">${errorStack}</pre>
      </div>

      <h3 style="color:#181D27;margin-bottom:8px;">What to check</h3>
      <ul style="color:#555;font-size:14px;line-height:1.6;margin:0 0 24px;padding-left:20px;">
        ${checklist}
      </ul>

      <p style="color:#555;font-size:14px;">Affected candidates are left in a <strong>failed</strong> state and will be retried by the daily cron job.</p>
    </div>

    ${EmailFooter}
  </div>
</body>
</html>`;
}
