'use strict';

/**
 * Serviço de coleta de dados de imóveis.
 *
 * Recebe um código de imóvel, abre a página pública correspondente em um
 * navegador headless (Playwright) e extrai os dados estruturados (JSON-LD +
 * blocos de características da página) para consumo por um agente de IA.
 *
 * OBS: URL base e sufixo do código são específicos do site de origem e
 * ficam fora deste repositório — configure via variáveis de ambiente.
 */

const express = require('express');
const crypto = require('crypto');
const { chromium } = require('playwright');

const app = express();

const PORT = Number(
  process.env.PORT ?? 3000
);

const API_KEY = String(
  process.env.COLLECTOR_API_KEY ?? ''
).trim();

const SITE_BASE_URL = String(
  process.env.SITE_BASE_URL ??
  'https://www.example-imobiliaria.com.br/imovel/'
).trim();

const CODIGO_SUFIXO = String(
  process.env.CODIGO_SUFIXO ?? ''
).trim();

const MAX_FILA = Number(
  process.env.MAX_FILA ?? 3
);

const MAX_COLETAS_POR_BROWSER = Number(
  process.env.MAX_COLETAS_POR_BROWSER ?? 5
);

const TIMEOUT_TOTAL_COLETA_MS = Number(
  process.env.TIMEOUT_TOTAL_COLETA_MS ?? 45000
);

if (!API_KEY) {
  throw new Error(
    'A variável COLLECTOR_API_KEY não foi configurada.'
  );
}

app.disable('x-powered-by');

app.use(
  express.json({
    limit: '200kb',
  })
);

let browserAtual = null;
let browserIniciando = null;
let coletasNoBrowserAtual = 0;

let fila = Promise.resolve();
let aguardandoNaFila = 0;
let coletaEmAndamento = false;

let servidor = null;
let encerrando = false;

const esperar = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const agoraIso = () =>
  new Date().toISOString();

function log(
  requestId,
  mensagem
) {
  console.log(
    `[${agoraIso()}]` +
    `${requestId ? ` [${requestId}]` : ''}` +
    ` ${mensagem}`
  );
}

function logErro(
  requestId,
  mensagem,
  erro
) {
  console.error(
    `[${agoraIso()}]` +
    `${requestId ? ` [${requestId}]` : ''}` +
    ` ${mensagem}:`,
    erro?.stack ??
    erro?.message ??
    erro
  );
}

function autenticar(
  req,
  res,
  next
) {
  const recebida = String(
    req.headers['x-api-key'] ?? ''
  );

  if (recebida !== API_KEY) {
    return res
      .status(401)
      .json({
        sucesso: false,

        status_coleta:
          'nao_autorizado',

        erro:
          'Não autorizado.',
      });
  }

  return next();
}

function normalizarCodigo(valor) {
  let codigo = String(valor ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

  if (!codigo) {
    throw new Error(
      'O código do imóvel não foi informado.'
    );
  }

  if (!/^[A-Z0-9-]{3,30}$/.test(codigo)) {
    throw new Error(
      'O código do imóvel possui formato inválido.'
    );
  }

  if (
    CODIGO_SUFIXO &&
    !codigo.endsWith(CODIGO_SUFIXO)
  ) {
    codigo += CODIGO_SUFIXO;
  }

  return codigo;
}

function criarHash(valor) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify(valor)
    )
    .digest('hex');
}

class PaginaNaoPublicadaError
  extends Error {
  constructor({
    codigo,
    statusHttp = null,
    urlSolicitada,
    urlFinal = null,

    motivo =
    'O imóvel não está publicado no site.',
  }) {
    super(motivo);

    this.name =
      'PaginaNaoPublicadaError';

    this.codigo =
      codigo;

    this.statusHttp =
      statusHttp;

    this.urlSolicitada =
      urlSolicitada;

    this.urlFinal =
      urlFinal;
  }
}

async function comTimeout(
  promessa,
  timeoutMs,
  mensagem
) {
  let timer;

  const timeout =
    new Promise(
      (_, reject) => {
        timer = setTimeout(
          () => {
            reject(
              new Error(mensagem)
            );
          },
          timeoutMs
        );
      }
    );

  try {
    return await Promise.race([
      promessa,
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function erroExigeNovoBrowser(
  erro
) {
  const mensagem = String(
    erro?.message ??
    erro ??
    ''
  ).toLowerCase();

  return [
    'target page, context or browser has been closed',
    'browser has been closed',
    'browser disconnected',
    'browser closed',
    'page crashed',
    'crashed',
  ].some(
    (trecho) =>
      mensagem.includes(trecho)
  );
}

async function fecharBrowser() {
  const browser =
    browserAtual;

  browserAtual = null;
  coletasNoBrowserAtual = 0;

  if (
    browser?.isConnected()
  ) {
    await browser
      .close()
      .catch(() => { });
  }
}

async function obterBrowser() {
  if (
    browserAtual?.isConnected() &&
    coletasNoBrowserAtual <
    MAX_COLETAS_POR_BROWSER
  ) {
    return browserAtual;
  }

  if (
    browserAtual?.isConnected() &&
    coletasNoBrowserAtual >=
    MAX_COLETAS_POR_BROWSER
  ) {
    log(
      null,
      'Reiniciando Chromium preventivamente.'
    );

    await fecharBrowser();
  }

  if (browserIniciando) {
    return browserIniciando;
  }

  browserIniciando =
    chromium
      .launch({
        headless: true,
      })
      .then((browser) => {
        browserAtual =
          browser;

        coletasNoBrowserAtual =
          0;

        browser.on(
          'disconnected',
          () => {
            if (
              browserAtual ===
              browser
            ) {
              browserAtual =
                null;

              coletasNoBrowserAtual =
                0;
            }

            logErro(
              null,

              'Chromium desconectado',

              new Error(
                'Navegador encerrado.'
              )
            );
          }
        );

        log(
          null,
          'Chromium iniciado.'
        );

        return browser;
      })
      .finally(() => {
        browserIniciando =
          null;
      });

  return browserIniciando;
}

function enfileirar(tarefa) {
  aguardandoNaFila += 1;

  const executar =
    async () => {
      aguardandoNaFila -= 1;
      coletaEmAndamento = true;

      try {
        return await tarefa();
      } finally {
        coletaEmAndamento =
          false;
      }
    };

  const promessa =
    fila.then(
      executar,
      executar
    );

  fila =
    promessa.catch(() => { });

  return promessa;
}

async function extrairDados(page) {
  return page.evaluate(() => {
    const limparTexto =
      (valor) =>
        String(valor ?? '')
          .replace(
            /​/g,
            ''
          )
          .replace(
            /\r/g,
            ''
          )
          .replace(
            /[ \t]+/g,
            ' '
          )
          .replace(
            /\n[ \t]+/g,
            '\n'
          )
          .replace(
            /\n{3,}/g,
            '\n\n'
          )
          .trim();

    const limparMarkdown =
      (valor) =>
        limparTexto(valor)
          .replace(
            /\*\*/g,
            ''
          )
          .replace(
            /__/g,
            ''
          )
          .replace(
            /`/g,
            ''
          )
          .replace(
            /^#+\s*/gm,
            ''
          )
          .trim();

    const unicos =
      (lista) => [
        ...new Set(
          lista
            .map(limparTexto)
            .filter(Boolean)
        ),
      ];

    const primeiro =
      (valor) =>
        Array.isArray(valor)
          ? valor[0] ?? null
          : valor ?? null;

    const primeiraOferta =
      (valor) =>
        Array.isArray(valor)
          ? valor[0] ?? {}
          : valor ?? {};

    const possuiTipo =
      (item, tipo) => {
        const tipos =
          item?.['@type'];

        return Array.isArray(
          tipos
        )
          ? tipos.includes(tipo)
          : tipos === tipo;
      };

    const numero =
      (valor) => {
        if (
          valor === null ||
          valor === undefined ||
          valor === ''
        ) {
          return null;
        }

        if (
          typeof valor ===
          'number'
        ) {
          return Number.isFinite(
            valor
          )
            ? valor
            : null;
        }

        const convertido =
          Number(
            String(valor)
              .replace(
                /[^\d,.-]/g,
                ''
              )
              .replace(
                /\.(?=\d{3}(?:\D|$))/g,
                ''
              )
              .replace(
                ',',
                '.'
              )
          );

        return Number.isFinite(
          convertido
        )
          ? convertido
          : null;
      };

    const normalizarTitulo =
      (valor) =>
        limparTexto(valor)
          .normalize('NFD')
          .replace(
            /[̀-ͯ]/g,
            ''
          )
          .toLowerCase();

    const blocosBrutos = [
      ...document
        .querySelectorAll(
          'script[type="application/ld+json"]'
        ),
    ]
      .map((script) => {
        try {
          return JSON.parse(
            script.textContent
          );
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const jsonLd = [];

    function adicionar(valor) {
      if (!valor) {
        return;
      }

      if (
        Array.isArray(valor)
      ) {
        valor.forEach(
          adicionar
        );

        return;
      }

      if (
        typeof valor !==
        'object'
      ) {
        return;
      }

      jsonLd.push(valor);

      if (
        Array.isArray(
          valor['@graph']
        )
      ) {
        valor['@graph']
          .forEach(adicionar);
      }
    }

    blocosBrutos
      .forEach(adicionar);

    const product =
      jsonLd.find(
        (item) =>
          possuiTipo(
            item,
            'Product'
          )
      ) ?? {};

    const listing =
      jsonLd.find(
        (item) =>
          possuiTipo(
            item,
            'RealEstateListing'
          )
      ) ?? {};

    const breadcrumb =
      jsonLd.find(
        (item) =>
          possuiTipo(
            item,
            'BreadcrumbList'
          )
      ) ?? {};

    const offer =
  primeiraOferta(
    product.offers ??
    listing.offers
  );

    const nomesBreadcrumb =
      (
        breadcrumb
          .itemListElement ??
        []
      )
        .map(
          (item) =>
            item?.item?.name ??
            item?.name ??
            null
        )
        .filter(Boolean);

    const seletores = [
      '.listing-details .box-amenities',
      '.box-detail .box-amenities',
      '.box-amenities',
    ];

    let seletorUsado =
      null;

    let caixas = [];

    for (
      const seletor
      of seletores
    ) {
      const encontradas = [
        ...document
          .querySelectorAll(
            seletor
          ),
      ];

      if (
        encontradas.length
      ) {
        seletorUsado =
          seletor;

        caixas =
          encontradas;

        break;
      }
    }

    const caracteristicasPorBloco =
      caixas
        .map(
          (
            caixa,
            indice
          ) => {
            const bloco =
              caixa.closest(
                '.box-detail'
              ) ??
              caixa.closest(
                '.details'
              ) ??
              caixa.parentElement;

            const titulo =
              limparTexto(
                bloco
                  ?.querySelector(
                    ':scope > h2, :scope > h3, :scope > h4'
                  )
                  ?.textContent
              ) ||
              limparTexto(
                bloco
                  ?.querySelector(
                    'h2, h3, h4'
                  )
                  ?.textContent
              ) ||
              `Bloco ${indice + 1}`;

            const itens =
              unicos(
                [
                  ...caixa
                    .querySelectorAll(
                      'p'
                    ),
                ].map(
                  (item) =>
                    item.textContent
                )
              );

            return {
              titulo,
              itens,
            };
          }
        )
        .filter(
          (bloco) =>
            bloco.itens.length
        );

    const blocoPrincipal =
      caracteristicasPorBloco
        .find(
          (bloco) =>
            normalizarTitulo(
              bloco.titulo
            ) ===
            'caracteristicas'
        ) ??
      caracteristicasPorBloco[0] ??
      null;

    const caracteristicasImovel =
      blocoPrincipal
        ?.itens ??
      [];

    const caracteristicasRelacionadas =
      caracteristicasPorBloco
        .filter(
          (bloco) =>
            bloco !==
            blocoPrincipal
        );

    const caracteristicasConsolidadas =
      unicos(
        caracteristicasPorBloco
          .flatMap(
            (bloco) =>
              bloco.itens
          )
      );

    const imagensListing =
      Array.isArray(
        listing.image
      )
        ? listing.image
        : [
          listing.image,
        ].filter(Boolean);

    const imagensProduct =
      Array.isArray(
        product.image
      )
        ? product.image
        : [
          product.image,
        ].filter(Boolean);

    const fotos =
      unicos([
        ...imagensListing,
        ...imagensProduct,
      ]);

    const descricaoOriginal =
      limparTexto(
        product.description ??
        listing.description
      );

    const disponibilidadeOriginal =
      offer.availability ??
      null;

    const disponibilidade =
      disponibilidadeOriginal
        ? String(
          disponibilidadeOriginal
        )
          .split('/')
          .filter(Boolean)
          .at(-1)
        : null;

    const finalidade =
      nomesBreadcrumb.some(
        (nome) =>
          /à venda|a venda|venda/i
            .test(
              String(nome)
            )
      )
        ? 'Venda'
        : nomesBreadcrumb.some(
          (nome) =>
            /aluguel|locação|locacao/i
              .test(
                String(nome)
              )
        )
          ? 'Locação'
          : null;

    return {
      schema_version: 1,

      codigo_site:
        product.sku ??
        nomesBreadcrumb.at(-1) ??
        null,

      tipo_imovel:
        limparTexto(
          nomesBreadcrumb[3]
        ) ||
        null,

      titulo:
        limparTexto(
          product.name ??
          listing.name ??
          document
            .querySelector('h1')
            ?.textContent
        ) ||
        null,

      descricao_original:
        descricaoOriginal ||
        null,

      descricao_limpa:
        limparMarkdown(
          descricaoOriginal
        ) ||
        null,

      finalidade,

      valor_venda:
        numero(
          offer.price
        ),

      moeda:
        offer.priceCurrency ??
        'BRL',

      disponibilidade,

      disponibilidade_original:
        disponibilidadeOriginal,

      bairro:
        nomesBreadcrumb[5] ||
        null,

      cidade:
        limparTexto(
          listing.address
            ?.addressLocality
        ) ||
        nomesBreadcrumb[4] ||
        null,

      pais:
        limparTexto(
          listing.address
            ?.addressCountry
        ) ||
        'BR',

      quartos:
        numero(
          primeiro(
            listing
              .numberOfRooms
          )
        ),

      banheiros:
        numero(
          primeiro(
            listing
              .numberOfBathroomsTotal
          )
        ),

      caracteristicas_imovel:
        caracteristicasImovel,

      caracteristicas_relacionadas:
        caracteristicasRelacionadas,

      caracteristicas_consolidadas:
        caracteristicasConsolidadas,

      caracteristicas_por_bloco:
        caracteristicasPorBloco,

      fotos,

      quantidade_fotos:
        fotos.length,

      imagem_principal:
        fotos[0] ??
        null,

      url_final:
        listing.url ??
        offer.URL ??
        offer.url ??
        window.location.href,

      diagnostico: {
        quantidade_json_ld:
          jsonLd.length,

        encontrou_product:
          Object.keys(
            product
          ).length > 0,

        encontrou_real_estate_listing:
          Object.keys(
            listing
          ).length > 0,

        encontrou_breadcrumb:
          Object.keys(
            breadcrumb
          ).length > 0,

        seletor_caracteristicas_usado:
          seletorUsado,

        quantidade_blocos:
          caracteristicasPorBloco
            .length,

        nomes_breadcrumb:
          nomesBreadcrumb,
      },
    };
  });
}

async function coletarImovel(
  codigoRecebido
) {
  const codigo =
    normalizarCodigo(
      codigoRecebido
    );

  const urlSolicitada =
    SITE_BASE_URL +
    encodeURIComponent(
      codigo
    );

  const browser =
    await obterBrowser();

  let context = null;
  let page = null;

  try {
    context =
      await browser.newContext({
        locale: 'pt-BR',

        viewport: {
          width: 1366,
          height: 900,
        },

        serviceWorkers:
          'block',
      });

    await context.route(
      '**/*',
      async (route) => {
        const tipo =
          route
            .request()
            .resourceType();

        if (
          [
            'image',
            'media',
            'font',
          ].includes(tipo)
        ) {
          await route.abort();

          return;
        }

        await route.continue();
      }
    );

    page =
      await context.newPage();

    page.setDefaultTimeout(
      15000
    );

    page.setDefaultNavigationTimeout(
      30000
    );

    const {
      resultado,
      statusHttp,
    } = await comTimeout(
      (
        async () => {
          const resposta =
            await page.goto(
              urlSolicitada,
              {
                waitUntil:
                  'domcontentloaded',

                timeout:
                  30000,
              }
            );

          const statusHttp =
            resposta?.status() ??
            null;

          const urlFinal =
            page.url();

          if (
            statusHttp === 404 ||
            statusHttp === 410
          ) {
            throw new PaginaNaoPublicadaError({
              codigo,
              statusHttp,
              urlSolicitada,
              urlFinal,

              motivo:
                `O imóvel ${codigo} não possui ` +
                'página publicada no site.',
            });
          }

          if (
            statusHttp &&
            statusHttp >= 400
          ) {
            throw new Error(
              `A página retornou HTTP ${statusHttp}.`
            );
          }

          const encontrouJsonLd =
            await page
              .waitForSelector(
                'script[type="application/ld+json"]',
                {
                  state:
                    'attached',

                  timeout:
                    10000,
                }
              )
              .then(() => true)
              .catch(() => false);

          if (!encontrouJsonLd) {
            throw new PaginaNaoPublicadaError({
              codigo,
              statusHttp,
              urlSolicitada,

              urlFinal:
                page.url(),

              motivo:
                `O imóvel ${codigo} não está ` +
                'publicado no site ou não possui JSON-LD.',
            });
          }

          await page
            .waitForSelector(
              '.listing-details',
              {
                state:
                  'attached',

                timeout:
                  8000,
              }
            )
            .catch(() => { });

          await page
            .waitForTimeout(
              750
            );

          const resultado =
            await extrairDados(
              page
            );

          return {
            resultado,
            statusHttp,
          };
        }
      )(),

      TIMEOUT_TOTAL_COLETA_MS,

      `A coleta excedeu ` +
      `${TIMEOUT_TOTAL_COLETA_MS} ms.`
    );

    if (
      !resultado
        .diagnostico
        .encontrou_product &&
      !resultado
        .diagnostico
        .encontrou_real_estate_listing
    ) {
      throw new PaginaNaoPublicadaError({
        codigo,
        statusHttp,
        urlSolicitada,

        urlFinal:
          page.url(),

        motivo:
          `O imóvel ${codigo} não está ` +
          'publicado no site.',
      });
    }

    const codigoRetornado =
      String(
        resultado.codigo_site ??
        ''
      )
        .trim()
        .toUpperCase();

    if (
      !codigoRetornado ||
      codigoRetornado !== codigo
    ) {
      throw new PaginaNaoPublicadaError({
        codigo,
        statusHttp,
        urlSolicitada,

        urlFinal:
          page.url(),

        motivo:
          `O site não retornou a página do imóvel ${codigo}.`,
      });
    }

    const dadosParaHash = {
      codigo_site:
        resultado.codigo_site,

      titulo:
        resultado.titulo,

      descricao_original:
        resultado
          .descricao_original,

      valor_venda:
        resultado.valor_venda,

      bairro:
        resultado.bairro,

      cidade:
        resultado.cidade,

      quartos:
        resultado.quartos,

      banheiros:
        resultado.banheiros,

      caracteristicas_consolidadas:
        resultado
          .caracteristicas_consolidadas,

      fotos:
        resultado.fotos,
    };

    coletasNoBrowserAtual += 1;

    return {
      sucesso: true,

      status_coleta:
        'success',

      codigo_solicitado:
        codigo,

      status_http:
        statusHttp,

      url_solicitada:
        urlSolicitada,

      url_final:
        resultado.url_final,

      conteudo_hash:
        criarHash(
          dadosParaHash
        ),

      coletado_em:
        agoraIso(),

      imovel:
        resultado,
    };
  } catch (erro) {
    if (
      erroExigeNovoBrowser(
        erro
      )
    ) {
      await fecharBrowser();
    }

    throw erro;
  } finally {
    if (page) {
      await page
        .close()
        .catch(() => { });
    }

    if (context) {
      await context
        .close()
        .catch(() => { });
    }
  }
}

async function coletarComTentativas(
  codigo,
  requestId
) {
  let ultimoErro;

  for (
    let tentativa = 1;
    tentativa <= 2;
    tentativa += 1
  ) {
    const inicio =
      Date.now();

    try {
      log(
        requestId,

        `Iniciando tentativa ${tentativa} ` +
        `para ${codigo}.`
      );

      const resultado =
        await coletarImovel(
          codigo
        );

      log(
        requestId,

        `Coleta concluída em ` +
        `${Date.now() - inicio} ms.`
      );

      return {
        ...resultado,

        tentativa,

        request_id:
          requestId,
      };
    } catch (erro) {
      if (
        erro instanceof
        PaginaNaoPublicadaError
      ) {
        coletasNoBrowserAtual += 1;

        log(
          requestId,

          `Sem página publicada: ` +
          `${erro.codigo}.`
        );

        return {
          sucesso: false,

          status_coleta:
            'sem_pagina',

          codigo_solicitado:
            erro.codigo,

          status_http:
            erro.statusHttp,

          url_solicitada:
            erro.urlSolicitada,

          url_final:
            erro.urlFinal,

          conteudo_hash:
            null,

          coletado_em:
            agoraIso(),

          erro:
            erro.message,

          tentativa,

          request_id:
            requestId,

          imovel:
            null,
        };
      }

      ultimoErro = erro;

      logErro(
        requestId,

        `Falha na tentativa ${tentativa}`,

        erro
      );

      if (
        tentativa < 2
      ) {
        if (
          erroExigeNovoBrowser(
            erro
          ) ||
          String(
            erro?.message ??
            ''
          ).includes(
            'excedeu'
          )
        ) {
          await fecharBrowser();
        }

        await esperar(2000);
      }
    }
  }

  throw ultimoErro;
}

app.get(
  '/health',
  async (req, res) => {
    return res.json({
      status:
        'ok',

      servico:
        'imovel-coletor',

      navegador_conectado:
        Boolean(
          browserAtual
            ?.isConnected()
        ),

      coleta_em_andamento:
        coletaEmAndamento,

      aguardando_na_fila:
        aguardandoNaFila,

      coletas_no_browser_atual:
        coletasNoBrowserAtual,

      horario:
        agoraIso(),
    });
  }
);

app.post(
  '/coletar-imovel',
  autenticar,
  async (req, res) => {
    const requestId =
      crypto.randomUUID();

    const codigoRecebido =
      req.body?.codigo;

    res.setHeader(
      'X-Request-ID',
      requestId
    );

    if (
      aguardandoNaFila >=
      MAX_FILA
    ) {
      return res
        .status(200)
        .json({
          sucesso: false,

          status_coleta:
            'ocupado',

          codigo_solicitado:
            codigoRecebido ??
            null,

          erro:
            'O coletor está ocupado. ' +
            'Tente novamente em alguns segundos.',

          request_id:
            requestId,

          aguardando_na_fila:
            aguardandoNaFila,

          coletado_em:
            agoraIso(),
        });
    }

    log(
      requestId,

      `Requisição recebida para ` +
      `${String(
        codigoRecebido ??
        ''
      )}.`
    );

    try {
      const resultado =
        await enfileirar(
          () =>
            coletarComTentativas(
              codigoRecebido,
              requestId
            )
        );

      return res
        .status(200)
        .json(resultado);
    } catch (erro) {
      const mensagem =
        erro?.message ??
        'Erro desconhecido.';

      const entradaInvalida =
        mensagem.includes(
          'não foi informado'
        ) ||
        mensagem.includes(
          'formato inválido'
        );

      return res
        .status(200)
        .json({
          sucesso: false,

          status_coleta:
            entradaInvalida
              ? 'invalid_code'
              : 'failure',

          codigo_solicitado:
            codigoRecebido ??
            null,

          status_http:
            null,

          erro:
            mensagem,

          tipo_erro:
            erro?.name ??
            'Error',

          request_id:
            requestId,

          coletado_em:
            agoraIso(),

          imovel:
            null,
        });
    }
  }
);

app.use(
  (
    erro,
    req,
    res,
    next
  ) => {
    if (
      erro instanceof
      SyntaxError &&
      'body' in erro
    ) {
      return res
        .status(200)
        .json({
          sucesso: false,

          status_coleta:
            'invalid_code',

          erro:
            'O corpo JSON é inválido.',

          coletado_em:
            agoraIso(),
        });
    }

    return next(erro);
  }
);

async function encerrar(sinal) {
  if (encerrando) {
    return;
  }

  encerrando = true;

  log(
    null,
    `Encerrando por ${sinal}.`
  );

  const finalizar =
    async () => {
      try {
        await fecharBrowser();
      } finally {
        process.exit(0);
      }
    };

  if (servidor) {
    servidor.close(
      finalizar
    );

    setTimeout(
      () => {
        process.exit(1);
      },
      10000
    ).unref();

    return;
  }

  await finalizar();
}

process.on(
  'SIGTERM',
  () => encerrar('SIGTERM')
);

process.on(
  'SIGINT',
  () => encerrar('SIGINT')
);

process.on(
  'unhandledRejection',
  (erro) => {
    logErro(
      null,

      'Promise rejeitada sem tratamento',

      erro
    );
  }
);

process.on(
  'uncaughtException',
  (erro) => {
    logErro(
      null,

      'Exceção não tratada',

      erro
    );
  }
);

servidor = app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `Coletor de imóveis iniciado ` +
      `na porta ${PORT}.`
    );
  }
);

servidor.requestTimeout =
  120000;

servidor.headersTimeout =
  125000;

servidor.keepAliveTimeout =
  5000;
