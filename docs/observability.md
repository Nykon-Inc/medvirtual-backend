# Observabilidade do backend

**Última atualização:** 2026-10-08

Ferramentas: **Sentry** (erros, traces, logs, monitor de cron, uptime) e **CloudWatch** (saúde das instâncias EC2).

## Estado atual

| Fase | O que é | Estado |
|---|---|---|
| 0 | Conta e projeto no Sentry, Organization Token, secrets no GitHub, `SENTRY_DSN` no `.env` das EC2 | Feito |
| 1 | Erros e traces da API e do worker SQS; source maps e release no deploy | Em staging (`dev`); falta chegar em produção (`main`) |
| 2 | Logs do `Logger` do Nest e `console.warn`/`console.error` no Sentry, com redação de e-mails e tokens | Em staging; falta chegar em produção |
| 3 | Transações das 5 filas BullMQ; monitor de cron `daily-commission-summary` | Em staging; falta chegar em produção |
| 4 | Alarmes do CloudWatch, monitor de uptime, alertas e dashboard no Sentry | **Pendente** (ver abaixo) |

## Pendência: Fase 4

Não tem código; é configuração nos consoles da AWS e do Sentry.

**Quando fazer:** depois que o código das Fases 1 a 3 estiver em produção e tiver rodado por pelo menos 24 horas. Antes disso não há dados de produção para escolher limiares, e o monitor de cron ainda não existe (ele é criado no primeiro check-in, às 06:00 UTC seguintes ao deploy em `main`).

### Na AWS (console, região `us-east-1`)

Instâncias: `i-0575587874b69c931` (prod) e `i-063760d997e14f60a` (dev).

- [ ] Tópico SNS `medvirtual-backend-alarms` (Standard) com assinatura por e-mail **confirmada**. Sem confirmar o e-mail, nenhum alarme chega.
- [ ] Alarme `StatusCheckFailed` na instância de prod: Maximum, período de 1 min, `>= 1` por 2 períodos → tópico SNS.
- [ ] Alarme `CPUUtilization` na instância de prod: Average, período de 5 min, `> 80` por 2 períodos → tópico SNS.
- [ ] Os mesmos dois alarmes na instância de dev.
- [ ] Opcional: CloudWatch Agent para memória e disco (a EC2 não reporta esses dois por padrão). Exige a policy `CloudWatchAgentServerPolicy` na role da instância. Memória é o risco mais provável: o Node roda com até 3 GB de heap.
- [ ] `pm2 install pm2-logrotate` nas duas instâncias (hoje os logs do PM2 crescem sem limite no disco).

Os quatro alarmes cabem na faixa gratuita do CloudWatch (10 alarmes).

### No Sentry

- [ ] Monitor de uptime: `GET` na URL **pública** de produção terminada em `/start`, intervalo de 1 min. Usar a URL que o frontend chama, não o IP da EC2, para cobrir também nginx e certificado. O plano grátis inclui 1 monitor.
- [ ] Conferir que o monitor de cron `daily-commission-summary` apareceu com o horário `0 6 * * *` UTC.
- [ ] Alertas, todos com `environment:production` e notificação por e-mail:
  - [ ] Issue nova.
  - [ ] Issue com mais de 20 eventos em 1 hora.
  - [ ] Taxa de erro acima de 5% por 5 minutos.
  - [ ] p95 de latência acima de 5 s por 10 minutos.
  - [ ] Falha ou ausência de check-in do monitor de cron.
  - [ ] Falha do monitor de uptime.
- [ ] Dashboard "Backend Health" com filtro `environment:production`: requests/min, taxa de erro, latência p50/p95, 10 endpoints mais lentos, top erros, dependências externas (spans `http.client` por domínio), queries lentas (spans `db`), filas (`queue.*`).
- [ ] Conferir a redação: em Explore → Logs, buscar por `@`. Não deve aparecer nenhum e-mail.

Os limiares acima são pontos de partida. Ajustar depois de uma semana, conforme o que disparar à toa.

## Limitações conhecidas

- **`/start` não testa banco nem Redis.** Ele só prova que o processo Node responde. Se o Postgres cair, o uptime continua verde; quem avisa é o alerta de taxa de erro.
- **`console.log` não vai para o Sentry**, só `console.warn` e `console.error`. Várias chamadas de `console.log` imprimem registros inteiros (contatos, organizações, payloads de webhook), e a redação automática só cobre e-mails e tokens. Para um log específico aparecer no Sentry, trocar por `this.logger.log(...)`.
- **Só um cron é monitorado**, para ficar no plano grátis. Ele funciona como sinal de vida do caminho `cron-dispatcher` → EC2; os outros crons só geram issue se lançarem exceção.
- **Não chamar `/cron/daily-commission-summary` em staging.** Não há regra do EventBridge para ele em dev, então o Sentry passaria a esperar um check-in diário de staging e marcaria "perdido" todo dia.
- **SDK fixado na v10** (`@sentry/nestjs`). A v11 exige Node ≥ 20.19 e o `.nvmrc` diz 18. Subir a versão só depois de confirmar o Node das EC2 e do CI.
- **Lambda não está instrumentado** (`src/lambda.ts`, `src/lambda-sqs.ts`), porque o deploy por Lambda está desativado.

## Onde está o código

| Arquivo | Papel |
|---|---|
| `src/instrument.ts` | Inicialização do SDK. Precisa ser o primeiro import de `main.ts` e `worker.ts`. |
| `src/common/observability/sentry-logger.ts` | Espelha o `Logger` do Nest para o Sentry. |
| `src/common/observability/redact-sensitive.ts` | Remove e-mails, tokens `Bearer` e JWTs dos logs. |
| `src/common/observability/trace-queue-job.decorator.ts` | `@TraceQueueJob` aplicado no `process()` de cada worker BullMQ. |
| `src/cron/cron.controller.ts` | `Sentry.withMonitor` no `daily-commission-summary`. |
| `.github/workflows/deploy-*-ec2.yml` | Upload de source maps e `SENTRY_RELEASE` no `pm2 reload`. |

Variáveis de ambiente: `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_RELEASE` (descritas em `.env.example`).
