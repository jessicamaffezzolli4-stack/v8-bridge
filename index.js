// ============================================================
// V8 BRIDGE — Servidor intermediário entre Helena CRM e Banco V8
// Segue as boas práticas do manual do Willian Maffezzolli
// ============================================================

const express = require("express");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// CONFIGURAÇÃO — lida do ambiente (.env no Railway)
// ------------------------------------------------------------
const V8_EMAIL    = process.env.V8_EMAIL;
const V8_PASSWORD = process.env.V8_PASSWORD;
const BRIDGE_KEY  = process.env.BRIDGE_KEY; // chave secreta pra Helena não chamar a rota de graça

const AUTH_URL   = "https://auth.v8sistema.com/oauth/token";
const API_BASE   = "https://bff.v8sistema.com";
const CLIENT_ID  = "DHWogdaYmEI8n5bwwxPDzulMlSK7dwIn";
const AUDIENCE   = "https://bff.v8sistema.com";

// ------------------------------------------------------------
// CACHE DE TOKEN V8
// (Willian: "sem cache, você estoura rate limit em segundos")
// ------------------------------------------------------------
let tokenCache = {
  accessToken: null,
  expiresAt: null,
};

async function getToken() {
  const MARGEM_MS = 5 * 60 * 1000; // renova 5 min antes de expirar

  if (
    tokenCache.accessToken &&
    tokenCache.expiresAt &&
    Date.now() < tokenCache.expiresAt - MARGEM_MS
  ) {
    return tokenCache.accessToken;
  }

  console.log("[auth] Renovando token V8...");

  const params = new URLSearchParams({
    grant_type: "password",
    username:   V8_EMAIL,
    password:   V8_PASSWORD,
    audience:   AUDIENCE,
    scope:      "openid profile email offline_access",
    client_id:  CLIENT_ID,
  });

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept":        "application/json",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Falha auth V8 (${res.status}): ${txt}`);
  }

  const data = await res.json();

  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt   = Date.now() + data.expires_in * 1000;

  console.log("[auth] Token V8 renovado com sucesso.");
  return tokenCache.accessToken;
}

// ------------------------------------------------------------
// HELPER: chamada autenticada pra V8
// ------------------------------------------------------------
async function v8Request(method, path, body = null) {
  const token = await getToken();

  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
      "Accept":        "application/json",
    },
  };

  if (body !== null) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, options);
  const text = await res.text();

  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  return { status: res.status, ok: res.ok, data: json, raw: text };
}

// ------------------------------------------------------------
// MAPA DE CONSULTAS PENDENTES
// chave: consultId  →  valor: { resolve, reject, timer }
// Willian: "isso é como você conecta o webhook com quem está esperando"
// ------------------------------------------------------------
const pendentes = new Map();

// ------------------------------------------------------------
// ROTA 1: Helena chama aqui pra consultar margem de um CPF
//
// POST /consultar
// Body: { cpf, nome, email, telefone, genero, nascimento }
// Retorna: { margem, nome, empregador, parcela_max, prazo_max } ou { erro }
// ------------------------------------------------------------
app.post("/consultar", async (req, res) => {

  // Valida chave de segurança
  if (BRIDGE_KEY && req.headers["x-bridge-key"] !== BRIDGE_KEY) {
    return res.status(401).json({ erro: "Chave de acesso inválida." });
  }

  const { cpf, nome, email, telefone, genero, nascimento } = req.body;

  if (!cpf || !nome || !email || !telefone) {
    return res.status(400).json({ erro: "Campos obrigatórios: cpf, nome, email, telefone." });
  }

  // Limpa CPF (só números)
  const cpfLimpo = cpf.replace(/\D/g, "");

  if (cpfLimpo.length !== 11) {
    return res.status(400).json({ erro: "CPF inválido. Informe 11 dígitos." });
  }

  // Trata telefone: separa DDD e número
  const telLimpo = telefone.replace(/\D/g, "");
  const ddd    = telLimpo.slice(0, 2);
  const numero = telLimpo.slice(2);

  if (numero.length < 8) {
    return res.status(400).json({ erro: "Telefone inválido." });
  }

  // Formata data de nascimento: aceita DD/MM/YYYY ou YYYY-MM-DD
  let nascFormatado = nascimento || "1990-01-01";
  if (nascFormatado.includes("/")) {
    const partes = nascFormatado.split("/");
    nascFormatado = `${partes[2]}-${partes[1]}-${partes[0]}`;
  }

  console.log(`[consultar] CPF=${cpfLimpo} iniciando consulta V8...`);

  try {

    // PASSO 1: Criar consulta na V8
    const consultRes = await v8Request("POST", "/private-consignment/consult", {
      borrowerDocumentNumber: cpfLimpo,
      gender:      genero === "feminino" ? "female" : "male",
      birthDate:   nascFormatado,
      signerName:  nome,
      signerEmail: email,
      signerPhone: {
        phoneNumber:  numero,
        countryCode: "55",
        areaCode:     ddd,
      },
    });

    if (!consultRes.ok) {
      // Erro 400: "já existe consulta ativa" — trata graciosamente
      if (
        consultRes.status === 400 &&
        consultRes.raw?.includes("consulta ativa")
      ) {
        return res.status(200).json({
          erro: "já_existe_consulta",
          mensagem: "Este CPF já tem uma consulta em andamento. Aguarde alguns minutos e tente novamente.",
        });
      }

      // Erro 403: fora do horário comercial
      if (consultRes.status === 403) {
        return res.status(200).json({
          erro: "fora_horario",
          mensagem: "Consultas CLT estão disponíveis das 8h às 18h em dias úteis. Tente novamente mais tarde.",
        });
      }

      console.error("[consultar] Erro criar consulta:", consultRes.raw);
      return res.status(200).json({
        erro: "erro_v8",
        mensagem: "Não foi possível iniciar a consulta. Tente novamente.",
      });
    }

    const consultId = consultRes.data?.consult_id;
    if (!consultId) {
      return res.status(200).json({
        erro: "sem_id",
        mensagem: "V8 não retornou ID da consulta.",
      });
    }

    console.log(`[consultar] consultId=${consultId} — autorizando...`);

    // PASSO 2: Autorizar consulta (aceita o termo de consentimento)
    // Willian: "body não pode ser vazio — V8 retorna erro se mandar null"
    await v8Request("POST", `/private-consignment/consult/${consultId}/authorize`, {});

    // PASSO 3: Aguardar webhook da V8 (até 25 segundos)
    // Helena tem timeout de 20s — usamos 18s pra ter margem de resposta
    const TIMEOUT_MS = 18_000;

    const resultado = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendentes.delete(consultId);
        resolve({
          aguardando: true,
          consultId,
          mensagem: "Consulta em andamento. Retorne o consultId pro cliente e aguarde o resultado.",
        });
      }, TIMEOUT_MS);

      pendentes.set(consultId, { resolve, reject, timer });
    });

    return res.status(200).json(resultado);

  } catch (err) {
    console.error("[consultar] Erro inesperado:", err.message);
    return res.status(200).json({
      erro: "erro_interno",
      mensagem: "Erro interno. Tente novamente.",
    });
  }
});

// ------------------------------------------------------------
// ROTA 2: Verificar status de uma consulta em andamento
//
// GET /status/:consultId
// Retorna o resultado se já chegou, ou "ainda aguardando"
// ------------------------------------------------------------
app.get("/status/:consultId", async (req, res) => {

  if (BRIDGE_KEY && req.headers["x-bridge-key"] !== BRIDGE_KEY) {
    return res.status(401).json({ erro: "Chave de acesso inválida." });
  }

  const { consultId } = req.params;

  try {
    const r = await v8Request("GET", `/private-consignment/consult/${consultId}`);

    if (!r.ok) {
      return res.status(200).json({ erro: "Consulta não encontrada.", consultId });
    }

    const status = r.data?.status?.toUpperCase();
    const TERMINAIS = ["SUCCESS", "FAILED", "REJECTED"];

    if (!TERMINAIS.includes(status)) {
      return res.status(200).json({
        aguardando: true,
        status,
        mensagem: "Consulta ainda em andamento. Tente novamente em instantes.",
      });
    }

    return res.status(200).json(montarResultado(r.data));

  } catch (err) {
    console.error("[status] Erro:", err.message);
    return res.status(200).json({ erro: "Erro ao verificar status." });
  }
});

// ------------------------------------------------------------
// ROTA 3: Simulação — calcula parcela e valor liberado
//
// POST /simular
// Body: { consultId, valorParcela } ou { consultId, valorDesejado }
// ------------------------------------------------------------
app.post("/simular", async (req, res) => {

  if (BRIDGE_KEY && req.headers["x-bridge-key"] !== BRIDGE_KEY) {
    return res.status(401).json({ erro: "Chave de acesso inválida." });
  }

  const { consultId, valorParcela, valorDesejado } = req.body;

  if (!consultId) {
    return res.status(400).json({ erro: "consultId é obrigatório." });
  }

  try {

    // Busca tabelas de taxa disponíveis
    const configsRes = await v8Request("GET", "/private-consignment/config");

    if (!configsRes.ok) {
      return res.status(200).json({ erro: "Não foi possível buscar tabelas de juros." });
    }

    // Escolhe tabela sem seguro (recomendação do Willian)
    const configs  = configsRes.data?.configs || [];
    const semSeguro = configs.find((c) => c.is_insured === false) ||
                      configs.find((c) => !(c.slug || "").toLowerCase().includes("seguro")) ||
                      configs[0];

    if (!semSeguro) {
      return res.status(200).json({ erro: "Nenhuma tabela de taxa disponível." });
    }

    // Monta payload da simulação
    const simPayload = {
      consult_id: consultId,
      config_id:  semSeguro.id,
      number_of_installments: 24,
    };

    if (valorParcela) {
      simPayload.installment_face_value = Number(valorParcela);
    } else if (valorDesejado) {
      simPayload.disbursed_amount = Number(valorDesejado);
    } else {
      simPayload.number_of_installments = 24;
    }

    const simRes = await v8Request("POST", "/private-consignment/simulation", simPayload);

    if (!simRes.ok) {
      console.error("[simular] Erro:", simRes.raw);
      return res.status(200).json({
        erro: "Não foi possível simular. Verifique os valores informados.",
      });
    }

    const sim = simRes.data;

    return res.status(200).json({
      simulationId:    sim.simulation_id || sim.id,
      valorLiberado:   sim.operation_amount || sim.disbursed_amount,
      valorParcela:    sim.installment_value || sim.installment_face_value,
      numeroParcelas:  sim.number_of_installments,
      taxaMensal:      sim.monthly_interest_rate,
      taxaAnual:       sim.annual_interest_rate,
      cet:             sim.cet,
    });

  } catch (err) {
    console.error("[simular] Erro:", err.message);
    return res.status(200).json({ erro: "Erro ao simular." });
  }
});

// ------------------------------------------------------------
// ROTA 4: WEBHOOK da V8
//
// POST /webhook/v8/consult
// A V8 chama essa rota automaticamente quando a consulta termina
// Willian: "SEMPRE retorne 200 — mesmo em erro. V8 entra em loop com não-2xx"
// ------------------------------------------------------------
app.post("/webhook/v8/consult", async (req, res) => {
  const body = req.body;

  // Teste de registro — V8 faz isso ao registrar o webhook
  if (body?.type === "webhook.test") {
    console.log("[webhook] Teste de registro recebido. OK.");
    return res.status(200).json({ ok: true });
  }

  const consultId = body?.consultId || body?.consult_id;
  const status    = body?.status?.toUpperCase();

  console.log(`[webhook] Recebido: consultId=${consultId} status=${status}`);

  // Verifica se tem alguém esperando por essa consulta
  const esperando = pendentes.get(consultId);

  if (esperando && ["SUCCESS", "FAILED", "REJECTED"].includes(status)) {
    clearTimeout(esperando.timer);
    pendentes.delete(consultId);

    // Busca detalhes completos
    try {
      const detalhe = await v8Request("GET", `/private-consignment/consult/${consultId}`);
      esperando.resolve(montarResultado(detalhe.data || body));
    } catch (_) {
      esperando.resolve(montarResultado(body));
    }
  }

  // SEMPRE retorna 200
  return res.status(200).json({ received: true });
});

// ------------------------------------------------------------
// ROTA 5: Registrar o webhook na V8
//
// POST /admin/registrar-webhook
// Roda 1× pra cada ambiente — registra a URL no servidor da V8
// ------------------------------------------------------------
app.post("/admin/registrar-webhook", async (req, res) => {

  if (BRIDGE_KEY && req.headers["x-bridge-key"] !== BRIDGE_KEY) {
    return res.status(401).json({ erro: "Chave de acesso inválida." });
  }

  const { urlBase } = req.body;

  if (!urlBase) {
    return res.status(400).json({ erro: "Informe urlBase. Ex: https://seu-projeto.railway.app" });
  }

  const webhookUrl = `${urlBase}/webhook/v8/consult`;

  try {
    const r = await v8Request(
      "POST",
      "/user/webhook/private-consignment/consult",
      { url: webhookUrl }
    );

    if (r.ok) {
      console.log(`[admin] Webhook registrado: ${webhookUrl}`);
      return res.status(200).json({ ok: true, webhookUrl, resposta: r.data });
    } else {
      return res.status(200).json({ erro: "V8 recusou o registro.", detalhe: r.raw });
    }
  } catch (err) {
    return res.status(200).json({ erro: err.message });
  }
});

// ------------------------------------------------------------
// ROTA 6: Health check — só pra confirmar que tá no ar
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.status(200).json({
    status: "online",
    servico: "V8 Bridge",
    hora: new Date().toISOString(),
  });
});

// ------------------------------------------------------------
// HELPER: transforma resposta da V8 em formato legível
// ------------------------------------------------------------
function montarResultado(data) {
  const status = data?.status?.toUpperCase();

  if (status === "SUCCESS") {
    const margem = parseFloat(data?.availableMarginValue || 0);
    const limites = data?.simulationLimit || {};

    return {
      sucesso: true,
      status: "APROVADO",
      consultId: data?.consultId || data?.consult_id,
      nome:       data?.name || data?.signerName,
      empregador: data?.employerName,
      admissao:   data?.admissionDate,
      margem:     margem,
      margemFormatada: `R$ ${margem.toFixed(2).replace(".", ",")}`,
      limiteParcela: {
        minParcelas: limites.installmentsMin,
        maxParcelas: limites.installmentsMax,
        minValor:    limites.valueMin,
        maxValor:    limites.valueMax,
      },
      mensagem: `Parabéns! Margem disponível: R$ ${margem.toFixed(2).replace(".", ",")}`,
    };
  }

  if (status === "REJECTED") {
    return {
      sucesso: false,
      status: "REJEITADO",
      consultId: data?.consultId || data?.consult_id,
      motivo:  data?.reason || data?.description || "Não elegível para o produto.",
      mensagem: "Infelizmente não há margem disponível para este CPF no momento.",
    };
  }

  if (status === "FAILED") {
    return {
      sucesso: false,
      status: "FALHA_TECNICA",
      consultId: data?.consultId || data?.consult_id,
      mensagem: "Ocorreu um erro técnico na consulta. Tente novamente mais tarde.",
    };
  }

  // Status intermediário
  return {
    aguardando: true,
    status,
    consultId: data?.consultId || data?.consult_id,
    mensagem: "Consulta em andamento. Aguarde.",
  };
}

// ------------------------------------------------------------
// START
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ V8 Bridge rodando na porta ${PORT}`);
  console.log(`   Variáveis: V8_EMAIL=${V8_EMAIL ? "✓" : "⚠ NÃO DEFINIDO"} | BRIDGE_KEY=${BRIDGE_KEY ? "✓" : "⚠ NÃO DEFINIDO"}`);
});
