import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ErroDeM3u8, ehMestra, ler, lerAtributos, lerMestra, lerMidia, lerResolucao, resolver, segmentoEm } from '../src/m3u8.js';

const AQUI = dirname(fileURLToPath(import.meta.url));

/** As playlists foram baixadas dos fluxos públicos de teste da Mux e da Apple. */
const amostra = (nome) => readFileSync(join(AQUI, 'amostras', nome), 'utf8');

const MUX_MESTRE = amostra('mux-mestre.m3u8');
const APPLE_MESTRE = amostra('apple-mestre.m3u8');
const APPLE_MIDIA = amostra('apple-midia.m3u8');

describe('lista de atributos', () => {
  it('a vírgula dentro das aspas não separa', () => {
    // É a armadilha mais cara do formato: um split(',') ingênuo parte o valor
    // de CODECS ao meio, e o player decide que não sabe tocar nada.
    const atributos = lerAtributos('BANDWIDTH=2149280,CODECS="mp4a.40.2,avc1.64001f",RESOLUTION=1280x720');

    assert.equal(atributos.BANDWIDTH, '2149280');
    assert.equal(atributos.CODECS, 'mp4a.40.2,avc1.64001f');
    assert.equal(atributos.RESOLUTION, '1280x720');
  });

  it('aceita espaço depois da vírgula dentro das aspas', () => {
    // A playlist da Apple escreve assim.
    const atributos = lerAtributos('BANDWIDTH=232370,CODECS="mp4a.40.2, avc1.4d4015"');

    assert.equal(atributos.CODECS, 'mp4a.40.2, avc1.4d4015');
  });

  it('aspas sem fechamento são recusadas', () => {
    assert.throws(() => lerAtributos('CODECS="sem fim'), ErroDeM3u8);
  });

  it('lista vazia devolve objeto vazio', () => {
    assert.deepEqual({ ...lerAtributos('') }, {});
  });

  it('a resolução vira largura e altura', () => {
    assert.deepEqual(lerResolucao('1920x1080'), { largura: 1920, altura: 1080 });
    assert.equal(lerResolucao('grande'), null);
    assert.equal(lerResolucao(''), null);
  });
});

describe('URLs relativas', () => {
  it('resolvem contra a playlist, não contra a página', () => {
    // Resolver contra o endereço da página daria em qualquer lugar.
    assert.equal(
      resolver('https://cdn.exemplo/x/y/mestre.m3u8', 'url_0/baixa.m3u8'),
      'https://cdn.exemplo/x/y/url_0/baixa.m3u8',
    );

    assert.equal(resolver('https://cdn.exemplo/x/y/mestre.m3u8', '/raiz.m3u8'), 'https://cdn.exemplo/raiz.m3u8');
    assert.equal(resolver('https://cdn.exemplo/x/y/mestre.m3u8', '../z/outra.m3u8'), 'https://cdn.exemplo/x/z/outra.m3u8');
  });

  it('URL absoluta passa intacta', () => {
    assert.equal(resolver('https://a/b.m3u8', 'https://outro/c.m3u8'), 'https://outro/c.m3u8');
  });

  it('sem base, a relativa fica como está', () => {
    assert.equal(resolver(null, 'a.m3u8'), 'a.m3u8');
  });
});

describe('a playlist mestra da Mux', () => {
  const { variantes } = lerMestra(MUX_MESTRE, 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');

  it('acha as cinco qualidades', () => {
    assert.equal(variantes.length, 5);
  });

  it('vem ordenada da menor para a maior banda', () => {
    // A playlist original está fora de ordem, e toda a adaptação depende disto.
    assert.deepEqual(
      variantes.map((v) => v.banda),
      [...variantes.map((v) => v.banda)].sort((a, b) => a - b),
    );

    assert.equal(variantes[0].banda, 246440);
    assert.equal(variantes.at(-1).banda, 6221600);
  });

  it('separa os codecs sem quebrá-los', () => {
    assert.deepEqual(variantes.at(-1).codecs, ['mp4a.40.2', 'avc1.640028']);
  });

  it('lê resolução e nome', () => {
    assert.deepEqual(variantes.at(-1).resolucao, { largura: 1920, altura: 1080 });
    assert.equal(variantes.at(-1).nome, '1080');
  });

  it('resolve a URL de cada variante contra a mestra', () => {
    for (const variante of variantes) {
      assert.match(variante.url, /^https:\/\/test-streams\.mux\.dev\/x36xhzz\/url_\d+\//);
    }
  });
});

describe('a playlist mestra da Apple', () => {
  const url = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8';
  const { variantes } = lerMestra(APPLE_MESTRE, url);

  it('atravessa as linhas em branco entre as variantes', () => {
    // Assumir que a URL é a linha logo abaixo do #EXT-X-STREAM-INF quebra
    // aqui: esta playlist tem uma linha vazia entre cada par.
    assert.ok(variantes.length >= 4);

    for (const variante of variantes) {
      assert.match(variante.url, /prog_index\.m3u8$/);
    }
  });

  it('reconhece que é mestra', () => {
    assert.equal(ehMestra(APPLE_MESTRE), true);
    assert.equal(ehMestra(APPLE_MIDIA), false);
  });
});

describe('a playlist de mídia da Apple', () => {
  const url = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/gear1/prog_index.m3u8';
  const midia = lerMidia(APPLE_MIDIA, url);

  it('acha todos os segmentos', () => {
    assert.equal(midia.segmentos.length, 181);
  });

  it('a tabulação depois da vírgula não vira duração nem título', () => {
    // Esta playlist escreve "#EXTINF:9.97667,\t" — um parser que confia no
    // formato limpo lê a tabulação como título ou quebra na duração.
    assert.equal(midia.segmentos[0].duracao, 9.97667);
    assert.equal(midia.segmentos[0].titulo, null);
  });

  it('calcula início e fim de cada segmento', () => {
    assert.equal(midia.segmentos[0].inicio, 0);
    assert.ok(Math.abs(midia.segmentos[1].inicio - 9.97667) < 1e-9);
    assert.ok(Math.abs(midia.duracaoTotal - midia.segmentos.at(-1).fim) < 1e-6);
  });

  it('o último segmento é mais curto, como é normal', () => {
    assert.equal(midia.segmentos.at(-1).duracao, 4.20333);
  });

  it('reconhece que é VOD, e não ao vivo', () => {
    // O #EXT-X-ENDLIST é o que separa os dois: sem ele, a playlist ainda vai
    // crescer e precisa ser recarregada.
    assert.equal(midia.aoVivo, false);
    assert.equal(midia.modo, 'VOD');
    assert.equal(midia.duracaoAlvo, 10);
    assert.equal(midia.versao, 3);
  });

  it('resolve as URLs dos segmentos', () => {
    assert.equal(
      midia.segmentos[0].url,
      'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/gear1/fileSequence0.ts',
    );
  });

  it('não é criptografada', () => {
    assert.equal(midia.criptografada, false);
  });

  it('a duração total bate com os dez minutos anunciados', () => {
    // 181 segmentos de ~10 s: o vídeo de exemplo tem cerca de 30 minutos.
    assert.ok(midia.duracaoTotal > 1790 && midia.duracaoTotal < 1810, `deu ${midia.duracaoTotal}`);
  });
});

describe('o que o formato permite e quase ninguém testa', () => {
  it('segmento ao vivo, sem ENDLIST', () => {
    const texto = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:120', '#EXTINF:4.0,', 'a.ts'].join('\n');
    const midia = lerMidia(texto);

    assert.equal(midia.aoVivo, true);
    assert.equal(midia.segmentos[0].sequencia, 120, 'a numeração continua de onde a janela começa');
  });

  it('faixa de bytes herda o deslocamento do segmento anterior', () => {
    // É assim que uma playlist descreve vários segmentos dentro de um arquivo
    // só; sem herdar, todos apontariam para o byte zero.
    const texto = [
      '#EXTM3U',
      '#EXTINF:4.0,',
      '#EXT-X-BYTERANGE:1000@0',
      'tudo.ts',
      '#EXTINF:4.0,',
      '#EXT-X-BYTERANGE:2000',
      'tudo.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const midia = lerMidia(texto);

    assert.deepEqual(midia.segmentos[0].faixa, { tamanho: 1000, deslocamento: 0 });
    assert.deepEqual(midia.segmentos[1].faixa, { tamanho: 2000, deslocamento: 1000 });
  });

  it('o segmento de inicialização do fMP4 é reconhecido', () => {
    const texto = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4.0,',
      'seg1.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const midia = lerMidia(texto, 'https://cdn/a/b/playlist.m3u8');

    assert.equal(midia.inicializacao.url, 'https://cdn/a/b/init.mp4');
  });

  it('a descontinuidade é marcada no segmento seguinte', () => {
    const texto = [
      '#EXTM3U',
      '#EXTINF:4.0,',
      'a.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:4.0,',
      'b.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const midia = lerMidia(texto);

    assert.equal(midia.segmentos[0].descontinuidade, false);
    assert.equal(midia.segmentos[1].descontinuidade, true);
  });

  it('playlist criptografada é sinalizada', () => {
    const texto = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="chave.bin"',
      '#EXTINF:4.0,',
      'a.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    assert.equal(lerMidia(texto).criptografada, true);
  });

  it('METHOD=NONE não conta como criptografia', () => {
    const texto = ['#EXTM3U', '#EXT-X-KEY:METHOD=NONE', '#EXTINF:4.0,', 'a.ts', '#EXT-X-ENDLIST'].join('\n');

    assert.equal(lerMidia(texto).criptografada, false);
  });
});

describe('playlist malformada', () => {
  it('sem #EXTM3U é recusada', () => {
    assert.throws(() => lerMidia('#EXTINF:4.0,\na.ts'), /começa com #EXTM3U/);
    assert.throws(() => lerMestra('#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8'), ErroDeM3u8);
  });

  it('variante sem BANDWIDTH é recusada', () => {
    const texto = ['#EXTM3U', '#EXT-X-STREAM-INF:RESOLUTION=1280x720', 'a.m3u8'].join('\n');

    assert.throws(() => lerMestra(texto), /BANDWIDTH/);
  });

  it('variante sem URL é recusada', () => {
    const texto = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1000'].join('\n');

    assert.throws(() => lerMestra(texto), /sem URL/);
  });

  it('duração inválida é recusada', () => {
    const texto = ['#EXTM3U', '#EXTINF:muito,', 'a.ts'].join('\n');

    assert.throws(() => lerMidia(texto), /Duração inválida/);
  });

  it('URL solta sem #EXTINF antes é ignorada, não vira segmento', () => {
    const texto = ['#EXTM3U', 'lixo.ts', '#EXTINF:4.0,', 'bom.ts', '#EXT-X-ENDLIST'].join('\n');
    const midia = lerMidia(texto);

    assert.equal(midia.segmentos.length, 1);
    assert.match(midia.segmentos[0].url, /bom\.ts$/);
  });

  it('mestra sem variante nenhuma é recusada', () => {
    assert.throws(() => lerMestra('#EXTM3U\n#EXT-X-VERSION:3'), /sem variante/);
  });
});

describe('ler decide sozinho o tipo', () => {
  it('reconhece a mestra e a de mídia', () => {
    assert.equal(ler(MUX_MESTRE).tipo, 'mestra');
    assert.equal(ler(APPLE_MIDIA).tipo, 'midia');
  });
});

describe('achar o segmento de um instante', () => {
  const midia = lerMidia(APPLE_MIDIA);

  it('o instante zero cai no primeiro', () => {
    assert.equal(segmentoEm(midia.segmentos, 0).sequencia, 0);
  });

  it('um instante no meio cai no segmento certo', () => {
    // Cada segmento tem ~9.98 s; 100 s cai no décimo primeiro.
    assert.equal(segmentoEm(midia.segmentos, 100).sequencia, 10);
  });

  it('além do fim cai no último, em vez de devolver nada', () => {
    assert.equal(segmentoEm(midia.segmentos, 999_999).sequencia, 180);
  });

  it('lista vazia devolve nulo', () => {
    assert.equal(segmentoEm([], 0), null);
  });
});
