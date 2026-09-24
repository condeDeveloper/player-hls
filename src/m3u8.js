/**
 * O analisador de playlist M3U8.
 *
 * Um fluxo HLS é feito de dois tipos de arquivo de texto, e confundi-los é o
 * erro número um de quem implementa isto:
 *
 * - A **playlist mestra** lista as *qualidades* disponíveis. Cada linha
 *   `#EXT-X-STREAM-INF` descreve uma variante — largura de banda, resolução,
 *   codecs — e a linha seguinte é a URL da playlist daquela variante.
 * - A **playlist de mídia** lista os *segmentos*. Cada `#EXTINF` diz a duração
 *   e a linha seguinte é a URL do pedaço de vídeo.
 *
 * O mesmo arquivo nunca é os dois. Quem trata tudo como uma coisa só acaba
 * tentando reproduzir uma playlist como se fosse vídeo.
 *
 * A armadilha mais cara está no formato de atributos:
 *
 *     #EXT-X-STREAM-INF:BANDWIDTH=2149280,CODECS="mp4a.40.2,avc1.64001f"
 *
 * Um `split(',')` ingênuo parte o valor de `CODECS` ao meio — e o resultado é
 * um player que decide, sozinho, que não sabe tocar nada.
 */

/** A playlist não está no formato esperado. */
export class ErroDeM3u8 extends Error {
  constructor(mensagem, linha = null) {
    super(linha === null ? mensagem : `${mensagem} (linha ${linha})`);
    this.name = 'ErroDeM3u8';
    this.linha = linha;
  }
}

/**
 * Lê uma lista de atributos.
 *
 * O formato é `CHAVE=valor,CHAVE="valor, com vírgula"`. A vírgula só separa
 * quando está **fora** das aspas, e é por isso que este laço existe em vez de
 * um `split`.
 */
export function lerAtributos(texto) {
  const atributos = Object.create(null);

  let i = 0;

  while (i < texto.length) {
    const igual = texto.indexOf('=', i);

    if (igual < 0) break;

    const chave = texto.slice(i, igual).trim();

    i = igual + 1;

    let valor;

    if (texto[i] === '"') {
      const fecha = texto.indexOf('"', i + 1);

      if (fecha < 0) throw new ErroDeM3u8(`Aspas sem fechamento no atributo ${chave}`);

      valor = texto.slice(i + 1, fecha);
      i = fecha + 1;

      // Depois das aspas vem a vírgula do próximo atributo, se houver.
      if (texto[i] === ',') i += 1;
    } else {
      const virgula = texto.indexOf(',', i);

      valor = (virgula < 0 ? texto.slice(i) : texto.slice(i, virgula)).trim();
      i = virgula < 0 ? texto.length : virgula + 1;
    }

    if (chave) atributos[chave] = valor;
  }

  return atributos;
}

/** `1920x1080` vira `{ largura, altura }`. */
export function lerResolucao(texto) {
  if (!texto) return null;

  const partes = String(texto).toLowerCase().split('x');

  if (partes.length !== 2) return null;

  const largura = Number(partes[0]);
  const altura = Number(partes[1]);

  return Number.isFinite(largura) && Number.isFinite(altura) ? { largura, altura } : null;
}

/**
 * Resolve uma URL relativa contra a da playlist.
 *
 * As URLs dentro de uma playlist são relativas **a ela**, não à página. Uma
 * playlist em `https://cdn/x/y/mestre.m3u8` com a linha `url_0/baixa.m3u8`
 * aponta para `https://cdn/x/y/url_0/baixa.m3u8` — e resolver contra o
 * endereço da página daria em qualquer lugar.
 */
export function resolver(base, relativa) {
  if (!base) return relativa;

  try {
    return new URL(relativa, base).toString();
  } catch {
    return relativa;
  }
}

/** Separa a playlist em linhas úteis, já sem espaço em volta. */
function linhasDe(texto) {
  return String(texto)
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0);
}

/** Indica se o texto é uma playlist mestra. */
export function ehMestra(texto) {
  return /^#EXT-X-STREAM-INF:/m.test(String(texto));
}

/**
 * Lê uma playlist mestra.
 *
 * @returns {{variantes: object[], midiaAlternativa: object[]}}
 */
export function lerMestra(texto, urlBase = null) {
  const linhas = linhasDe(texto);

  if (linhas[0] !== '#EXTM3U') {
    throw new ErroDeM3u8('Toda playlist começa com #EXTM3U', 1);
  }

  const variantes = [];
  const midiaAlternativa = [];

  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i];

    if (linha.startsWith('#EXT-X-MEDIA:')) {
      const atributos = lerAtributos(linha.slice('#EXT-X-MEDIA:'.length));

      midiaAlternativa.push({
        tipo: atributos['TYPE'] ?? '',
        grupo: atributos['GROUP-ID'] ?? '',
        nome: atributos['NAME'] ?? '',
        idioma: atributos['LANGUAGE'] ?? null,
        padrao: atributos['DEFAULT'] === 'YES',
        url: atributos['URI'] ? resolver(urlBase, atributos['URI']) : null,
      });

      continue;
    }

    if (!linha.startsWith('#EXT-X-STREAM-INF:')) continue;

    const atributos = lerAtributos(linha.slice('#EXT-X-STREAM-INF:'.length));

    // A URL é a **próxima linha que não é comentário**. Assumir que é sempre
    // a linha imediatamente seguinte quebra em playlist com comentário no
    // meio — e a da Apple tem linhas em branco entre as variantes.
    let j = i + 1;

    while (j < linhas.length && linhas[j].startsWith('#')) j += 1;

    if (j >= linhas.length) {
      throw new ErroDeM3u8('Variante sem URL depois do #EXT-X-STREAM-INF', i + 1);
    }

    const banda = Number(atributos['BANDWIDTH']);

    if (!Number.isFinite(banda) || banda <= 0) {
      throw new ErroDeM3u8('Variante sem BANDWIDTH, que é obrigatório', i + 1);
    }

    variantes.push({
      url: resolver(urlBase, linhas[j]),
      banda,
      bandaMedia: Number(atributos['AVERAGE-BANDWIDTH']) || null,
      // Os codecs vêm separados por vírgula **dentro das aspas**, e alguns
      // servidores ainda põem espaço depois dela.
      codecs: (atributos['CODECS'] ?? '').split(',').map((c) => c.trim()).filter(Boolean),
      resolucao: lerResolucao(atributos['RESOLUTION']),
      quadros: Number(atributos['FRAME-RATE']) || null,
      nome: atributos['NAME'] ?? null,
      grupoDeAudio: atributos['AUDIO'] ?? null,
    });

    i = j;
  }

  if (variantes.length === 0) {
    throw new ErroDeM3u8('Playlist mestra sem variante nenhuma');
  }

  // Da menor para a maior banda: toda a lógica de adaptação depende disso, e
  // playlists no mundo real vêm em qualquer ordem.
  variantes.sort((a, b) => a.banda - b.banda);

  return { variantes, midiaAlternativa };
}

/**
 * Lê uma playlist de mídia.
 *
 * @returns {{segmentos: object[], duracaoAlvo: number, sequenciaInicial: number,
 *   aoVivo: boolean, versao: number, modo: string|null, inicializacao: object|null,
 *   criptografada: boolean, duracaoTotal: number}}
 */
export function lerMidia(texto, urlBase = null) {
  const linhas = linhasDe(texto);

  if (linhas[0] !== '#EXTM3U') {
    throw new ErroDeM3u8('Toda playlist começa com #EXTM3U', 1);
  }

  const segmentos = [];

  let duracaoAlvo = 0;
  let sequenciaInicial = 0;
  let versao = 1;
  let modo = null;
  let terminou = false;
  let criptografada = false;
  let inicializacao = null;

  let duracaoPendente = null;
  let tituloPendente = null;
  let faixaPendente = null;
  let descontinuidadePendente = false;
  let inicio = 0;

  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i];

    if (!linha.startsWith('#')) {
      if (duracaoPendente === null) {
        // Uma URL sem #EXTINF antes não é segmento; é lixo ou outro formato.
        continue;
      }

      segmentos.push({
        url: resolver(urlBase, linha),
        duracao: duracaoPendente,
        titulo: tituloPendente,
        sequencia: sequenciaInicial + segmentos.length,
        inicio,
        fim: inicio + duracaoPendente,
        faixa: faixaPendente,
        descontinuidade: descontinuidadePendente,
      });

      inicio += duracaoPendente;
      duracaoPendente = null;
      tituloPendente = null;
      faixaPendente = null;
      descontinuidadePendente = false;

      continue;
    }

    if (linha.startsWith('#EXTINF:')) {
      const conteudo = linha.slice('#EXTINF:'.length);
      const virgula = conteudo.indexOf(',');
      const bruto = virgula < 0 ? conteudo : conteudo.slice(0, virgula);
      const duracao = Number(bruto.trim());

      if (!Number.isFinite(duracao) || duracao < 0) {
        throw new ErroDeM3u8(`Duração inválida em #EXTINF: ${JSON.stringify(bruto)}`, i + 1);
      }

      duracaoPendente = duracao;

      // O título vem depois da vírgula e quase sempre é vazio — mas há
      // servidor que põe uma tabulação ali, e ela não é o título.
      const resto = virgula < 0 ? '' : conteudo.slice(virgula + 1).trim();

      tituloPendente = resto.length > 0 ? resto : null;

      continue;
    }

    if (linha.startsWith('#EXT-X-TARGETDURATION:')) {
      duracaoAlvo = Number(linha.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
      continue;
    }

    if (linha.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequenciaInicial = Number(linha.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) || 0;
      continue;
    }

    if (linha.startsWith('#EXT-X-VERSION:')) {
      versao = Number(linha.slice('#EXT-X-VERSION:'.length)) || 1;
      continue;
    }

    if (linha.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      modo = linha.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim();
      continue;
    }

    if (linha === '#EXT-X-ENDLIST') {
      terminou = true;
      continue;
    }

    if (linha === '#EXT-X-DISCONTINUITY') {
      descontinuidadePendente = true;
      continue;
    }

    if (linha.startsWith('#EXT-X-BYTERANGE:')) {
      faixaPendente = lerFaixa(linha.slice('#EXT-X-BYTERANGE:'.length), segmentos.at(-1));
      continue;
    }

    if (linha.startsWith('#EXT-X-MAP:')) {
      const atributos = lerAtributos(linha.slice('#EXT-X-MAP:'.length));

      // O segmento de inicialização do fMP4: ele traz o `moov` e precisa ser
      // o primeiro a entrar no buffer, senão nada depois é decodificável.
      inicializacao = {
        url: resolver(urlBase, atributos['URI'] ?? ''),
        faixa: atributos['BYTERANGE'] ? lerFaixa(atributos['BYTERANGE'], null) : null,
      };

      continue;
    }

    if (linha.startsWith('#EXT-X-KEY:')) {
      const atributos = lerAtributos(linha.slice('#EXT-X-KEY:'.length));

      if ((atributos['METHOD'] ?? 'NONE') !== 'NONE') criptografada = true;
    }
  }

  return {
    segmentos,
    duracaoAlvo,
    sequenciaInicial,
    versao,
    // VOD ou EVENT. Não confundir com o `tipo` que `ler` devolve, que diz
    // se a playlist é mestra ou de mídia — são duas perguntas diferentes.
    modo,
    // Sem #EXT-X-ENDLIST a playlist é ao vivo: ela vai crescer, e o player
    // precisa recarregá-la de tempos em tempos.
    aoVivo: !terminou,
    criptografada,
    inicializacao,
    duracaoTotal: segmentos.reduce((total, s) => total + s.duracao, 0),
  };
}

/** `tamanho@deslocamento`, com o deslocamento herdado do segmento anterior. */
function lerFaixa(texto, anterior) {
  const [tamanhoBruto, deslocamentoBruto] = String(texto).trim().split('@');
  const tamanho = Number(tamanhoBruto);

  if (!Number.isFinite(tamanho)) throw new ErroDeM3u8(`Faixa de bytes inválida: ${texto}`);

  if (deslocamentoBruto !== undefined) {
    return { tamanho, deslocamento: Number(deslocamentoBruto) };
  }

  // Sem deslocamento, ele continua de onde o segmento anterior parou — é
  // assim que uma playlist descreve vários segmentos dentro de um arquivo só.
  const anteriorFim = anterior?.faixa ? anterior.faixa.deslocamento + anterior.faixa.tamanho : 0;

  return { tamanho, deslocamento: anteriorFim };
}

/** Lê qualquer playlist, decidindo sozinho qual é. */
export function ler(texto, urlBase = null) {
  return ehMestra(texto)
    ? { tipo: 'mestra', ...lerMestra(texto, urlBase) }
    : { tipo: 'midia', ...lerMidia(texto, urlBase) };
}

/** O segmento que contém um instante, ou o primeiro depois dele. */
export function segmentoEm(segmentos, segundo) {
  for (const segmento of segmentos) {
    if (segundo < segmento.fim) return segmento;
  }

  return segmentos.at(-1) ?? null;
}
