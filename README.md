# V8 Bridge — Guia Completo de Instalação

Servidor intermediário entre a Helena CRM e o Banco V8.
Você não precisa saber programar pra seguir esse guia.

---

## O que esse servidor faz

Quando a Helena chama esse servidor com o CPF do cliente, ele:
1. Autentica no V8 (com cache pra não estourar limite)
2. Cria a consulta de margem
3. Aguarda o resultado via webhook
4. Devolve o resultado pra Helena com tudo formatado

---

## Passo 1 — Subir no Railway

1. Acesse https://railway.app e entre na sua conta
2. Clique em "New Project"
3. Escolha "Deploy from GitHub repo"
   - Se não tiver GitHub: crie uma conta em github.com (de graça)
   - Crie um repositório novo chamado "v8-bridge"
   - Faça upload dos arquivos: index.js e package.json
4. O Railway detecta automaticamente e faz o deploy

---

## Passo 2 — Configurar as variáveis de ambiente

No painel do Railway, clique no seu projeto → aba "Variables" → adicione:

| Nome        | Valor                              |
|-------------|-------------------------------------|
| V8_EMAIL    | seu e-mail de login no V8           |
| V8_PASSWORD | sua senha do V8 (nova, que trocou)  |
| BRIDGE_KEY  | qualquer texto secreto (ex: "minha-chave-2024-xyz") |

Depois de adicionar, o Railway reinicia automaticamente.

---

## Passo 3 — Pegar a URL do seu servidor

No painel do Railway, clique em "Settings" → "Domains" → copie a URL.
Vai ser algo como: https://v8-bridge-production-xxxx.up.railway.app

---

## Passo 4 — Registrar o webhook na V8

Esse passo é crítico. Sem ele, a V8 não sabe pra onde mandar os resultados.

Abra o Postman, Insomnia, ou qualquer ferramenta de API e faça:

POST https://SUA-URL.railway.app/admin/registrar-webhook
Header: x-bridge-key: sua-bridge-key-aqui
Body (JSON): { "urlBase": "https://SUA-URL.railway.app" }

Se retornar { "ok": true }, está configurado.

---

## Passo 5 — Configurar na Helena

No Agente Inteligente da Helena, crie uma habilidade "Acionar API":

### Para consultar CPF:
- URL: https://SUA-URL.railway.app/consultar
- Método: POST
- Header: x-bridge-key → sua-bridge-key-aqui
- Body: 
  {
    "cpf": "{{cpf_do_cliente}}",
    "nome": "{{nome_do_cliente}}",
    "email": "{{email_do_cliente}}",
    "telefone": "{{telefone_do_cliente}}",
    "genero": "masculino",
    "nascimento": "{{data_nascimento}}"
  }

### Para verificar status (se demorar mais de 18s):
- URL: https://SUA-URL.railway.app/status/{{consultId}}
- Método: GET
- Header: x-bridge-key → sua-bridge-key-aqui

---

## Rotas disponíveis

| Rota                          | Método | O que faz                          |
|-------------------------------|--------|------------------------------------|
| /                             | GET    | Verifica se está no ar             |
| /consultar                    | POST   | Consulta margem de um CPF no V8    |
| /status/:consultId            | GET    | Verifica resultado de consulta     |
| /simular                      | POST   | Simula parcela e valor liberado     |
| /webhook/v8/consult           | POST   | Recebe resultado da V8 (automático)|
| /admin/registrar-webhook      | POST   | Registra URL do webhook na V8      |

---

## O que cada resposta significa

### Consulta aprovada:
{
  "sucesso": true,
  "status": "APROVADO",
  "margem": 450.00,
  "margemFormatada": "R$ 450,00",
  "empregador": "Empresa Tal LTDA",
  "mensagem": "Parabéns! Margem disponível: R$ 450,00"
}

### Consulta rejeitada:
{
  "sucesso": false,
  "status": "REJEITADO",
  "mensagem": "Infelizmente não há margem disponível para este CPF no momento."
}

### Consulta ainda processando (normal nos primeiros segundos):
{
  "aguardando": true,
  "consultId": "abc123",
  "mensagem": "Consulta em andamento. Retorne o consultId pro cliente e aguarde."
}

---

## Atenção

- Consultas CLT só funcionam das 8h às 18h em dias úteis (limitação da V8)
- Se o resultado demorar, use a rota /status para verificar depois
- Nunca compartilhe sua BRIDGE_KEY publicamente
