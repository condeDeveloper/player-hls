/**
 * O player.
 *
 * Junta as peças: baixa a playlist, escolhe a variante, busca os segmentos e
 * empurra os bytes para o `<video>` pelo MediaSource.
 *
 * O laço de carregamento é o coração, e ele é guiado por **uma pergunta só**:
 * quantos segundos de vídeo já estão no buffer à frente da posição atual? Se
 * forem menos do que o alvo, busca o próximo segmento; se não, espera.
 *
 * Isso parece óbvio e é o que evita os dois extremos: baixar o filme inteiro
 * de uma vez, gastando banda de quem vai assistir cinco minutos, e baixar
 * apertado demais, travando a cada oscilação da rede.
 */

import { Adaptador, EstimadorDeBanda } from './adaptacao.js';
import { FilaDeBuffer, bufferAdiante } from './buffer.js';
import { ler, lerMidia, segmentoEm } from './m3u8.js';

/** O player não pôde tocar. */
export class ErroDePlayer extends Error {
  constructor(mensagem, causa = null) {
    super(mensagem);
    this.name = 'ErroDePlayer';
    this.causa = causa;
  }
}

/** Um player de HLS sobre MediaSource Extensions. */
export class PlayerHls extends EventTarget {
  /**
   * @param {HTMLVideoElement} video
   * @param {{bufferAlvo?: number, buscar?: Function, MediaSource?: Function}} opcoes
   */
  constructor(video, { bufferAlvo = 30, buscar = null, MediaSource: Fonte = null } = {}) {
    super();

    this.video = video;
    this.bufferAlvo = bufferAlvo;
    this.buscar = buscar ?? ((...args) => globalThis.fetch(...args));
    this.Fonte = Fonte ?? globalThis.MediaSource;

    this.banda = new EstimadorDeBanda();
    this.adaptador = null;
    this.mestra = null;
    this.midia = null;
    this.fila = null;
    this.fonte = null;
    this.proximoIndice = 0;
    this.carregando = false;
    this.parado = true;
    this.inicializacaoEnviada = false;
    this.urlDaVariante = null;
  }

  /** Se o navegador consegue tocar este fluxo. */
  static suportado(Fonte = globalThis.MediaSource) {
    return typeof Fonte === 'function' && typeof Fonte.isTypeSupported === 'function';
  }

  /** O tipo MIME a declarar ao MediaSource, a partir dos codecs da variante. */
  static tipoDe(variante) {
    const codecs = variante?.codecs ?? [];
    // `.ts` pede `video/mp2t`; fMP4 pede `video/mp4`. A decisão sai da
    // extensão do primeiro segmento, então quem chama informa.
    const base = variante?.contenedor === 'mp4' ? 'video/mp4' : 'video/mp2t';

    return codecs.length > 0 ? `${base}; codecs="${codecs.join(',')}"` : base;
  }

  /** Avisa quem está ouvindo. */
  avisar(nome, detalhe = {}) {
    this.dispatchEvent(new CustomEvent(nome, { detail: detalhe }));
  }

  /** Baixa uma playlist e a interpreta. */
  async baixarPlaylist(url) {
    const resposta = await this.buscar(url);

    if (!resposta.ok) {
      throw new ErroDePlayer(`A playlist ${url} respondeu ${resposta.status}.`);
    }

    return ler(await resposta.text(), url);
  }

  /**
   * Carrega um fluxo.
   *
   * @param {string} url a playlist mestra ou de mídia
   */
  async carregar(url) {
    const playlist = await this.baixarPlaylist(url);

    if (playlist.tipo === 'mestra') {
      this.mestra = playlist;
      this.adaptador = new Adaptador(playlist.variantes);
      this.avisar('qualidades', { qualidades: this.adaptador.rotulos() });

      await this.trocarVariante(this.adaptador.atual);
    } else {
      // Uma playlist de mídia direta é um fluxo de qualidade única — não há
      // o que adaptar.
      this.midia = playlist;
      this.urlDaVariante = url;
      this.adaptador = new Adaptador([{ banda: 1, url, codecs: [] }]);
    }

    if (this.midia.criptografada) {
      throw new ErroDePlayer('Este fluxo é criptografado, e este player não decifra.');
    }

    this.avisar('carregado', {
      duracao: this.midia.duracaoTotal,
      aoVivo: this.midia.aoVivo,
      segmentos: this.midia.segmentos.length,
    });

    return this.midia;
  }

  /** Troca a variante, recarregando a playlist de mídia dela. */
  async trocarVariante(indice) {
    const variante = this.adaptador.variantes[indice];
    const resposta = await this.buscar(variante.url);

    if (!resposta.ok) {
      throw new ErroDePlayer(`A variante ${indice} respondeu ${resposta.status}.`);
    }

    this.midia = lerMidia(await resposta.text(), variante.url);
    this.urlDaVariante = variante.url;
    this.adaptador.atual = indice;

    this.avisar('qualidade', { indice, variante });

    return this.midia;
  }

  /**
   * Prepara o MediaSource e prende ao `<video>`.
   *
   * A ordem importa: o `SourceBuffer` só pode ser criado depois de o
   * `MediaSource` abrir, e ele só abre depois de o `<video>` começar a
   * carregar a URL do objeto. Criar antes lança `InvalidStateError`.
   */
  prender(tipoMime) {
    if (!PlayerHls.suportado(this.Fonte)) {
      throw new ErroDePlayer('Este ambiente não tem MediaSource Extensions.');
    }

    if (!this.Fonte.isTypeSupported(tipoMime)) {
      throw new ErroDePlayer(`O navegador não toca ${tipoMime}.`);
    }

    return new Promise((cumprir, rejeitar) => {
      this.fonte = new this.Fonte();

      const aoAbrir = () => {
        this.fonte.removeEventListener('sourceopen', aoAbrir);

        try {
          this.fila = new FilaDeBuffer(this.fonte.addSourceBuffer(tipoMime));
          cumprir(this.fila);
        } catch (erro) {
          rejeitar(new ErroDePlayer(`Não consegui criar o SourceBuffer: ${erro?.message}`, erro));
        }
      };

      this.fonte.addEventListener('sourceopen', aoAbrir);
      this.video.src = URL.createObjectURL(this.fonte);
    });
  }

  /**
   * Decide se é hora de buscar mais.
   *
   * @returns {boolean}
   */
  precisaDeMais() {
    if (this.carregando || this.parado) return false;

    if (this.proximoIndice >= this.midia.segmentos.length) return false;

    return bufferAdiante(this.video.buffered, this.video.currentTime) < this.bufferAlvo;
  }

  /** Busca um segmento e mede o tempo, alimentando a estimativa de banda. */
  async buscarSegmento(segmento) {
    const opcoes = segmento.faixa
      ? { headers: { Range: `bytes=${segmento.faixa.deslocamento}-${segmento.faixa.deslocamento + segmento.faixa.tamanho - 1}` } }
      : undefined;

    const comecou = Date.now();
    const resposta = await this.buscar(segmento.url, opcoes);

    if (!resposta.ok) {
      throw new ErroDePlayer(`O segmento ${segmento.sequencia} respondeu ${resposta.status}.`);
    }

    const bytes = await resposta.arrayBuffer();

    this.banda.registrar(bytes.byteLength, Date.now() - comecou);

    return bytes;
  }

  /** Um passo do laço: busca o próximo segmento, se for hora. */
  async passo() {
    if (!this.precisaDeMais()) return false;

    this.carregando = true;

    try {
      // A troca de qualidade acontece **entre** segmentos, nunca no meio de
      // um: emendar dois codecs diferentes no mesmo ponto do buffer quebra a
      // decodificação.
      if (this.adaptador.automatico && this.mestra) {
        const escolhida = this.adaptador.escolher({
          banda: this.banda.estimativa(),
          bufferAdiante: bufferAdiante(this.video.buffered, this.video.currentTime),
        });

        if (escolhida !== this.adaptador.atual) {
          await this.trocarVariante(escolhida);
        }
      }

      if (this.midia.inicializacao && !this.inicializacaoEnviada) {
        const resposta = await this.buscar(this.midia.inicializacao.url);

        await this.fila.acrescentar(new Uint8Array(await resposta.arrayBuffer()));
        this.inicializacaoEnviada = true;
      }

      const segmento = this.midia.segmentos[this.proximoIndice];
      const bytes = await this.buscarSegmento(segmento);

      await this.fila.acrescentar(new Uint8Array(bytes));

      this.proximoIndice += 1;

      this.avisar('segmento', {
        sequencia: segmento.sequencia,
        bytes: bytes.byteLength,
        banda: this.banda.estimativa(),
      });

      if (this.proximoIndice >= this.midia.segmentos.length && !this.midia.aoVivo) {
        this.fonte?.endOfStream?.();
        this.avisar('fim', {});
      }

      return true;
    } finally {
      this.carregando = false;
    }
  }

  /** Salta para um instante, recomeçando a busca a partir dali. */
  saltarPara(segundo) {
    const segmento = segmentoEm(this.midia.segmentos, segundo);

    if (!segmento) return;

    this.proximoIndice = this.midia.segmentos.indexOf(segmento);
    this.video.currentTime = segundo;

    this.avisar('salto', { segundo, sequencia: segmento.sequencia });
  }

  /** Começa o laço de carregamento. */
  iniciar(intervalo = 250) {
    this.parado = false;

    this.relogio = setInterval(() => {
      this.passo().catch((erro) => this.avisar('erro', { erro }));
    }, intervalo);

    return this;
  }

  /** Para tudo e solta os recursos. */
  parar() {
    this.parado = true;

    if (this.relogio) clearInterval(this.relogio);

    this.fila?.destruir();

    if (this.video.src?.startsWith('blob:')) URL.revokeObjectURL(this.video.src);
  }
}
