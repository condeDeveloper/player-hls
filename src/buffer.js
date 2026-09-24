/**
 * O buffer do MediaSource.
 *
 * O `SourceBuffer` é a peça que permite alimentar um `<video>` com bytes que o
 * próprio código baixou — é o que torna possível escrever um player de HLS em
 * JavaScript, já que nenhum navegador além do Safari toca `.m3u8` nativamente.
 *
 * Ele tem três comportamentos que precisam ser respeitados, e desrespeitar
 * qualquer um deles produz o mesmo sintoma inútil: `InvalidStateError`.
 *
 * 1. **`appendBuffer` é assíncrono.** Ele volta na hora, mas o buffer fica
 *    `updating` até terminar. Chamar de novo antes disso lança. Por isso aqui
 *    existe uma fila, e não uma chamada direta.
 * 2. **A memória é finita.** Quando enche, o navegador lança
 *    `QuotaExceededError` — e a resposta certa não é desistir, é **apagar o
 *    que já passou** e tentar de novo.
 * 3. **Remover também é assíncrono**, e concorre com o acréscimo pela mesma
 *    fila.
 */

/** O buffer não pôde receber os dados. */
export class ErroDeBuffer extends Error {
  constructor(mensagem, causa = null) {
    super(mensagem);
    this.name = 'ErroDeBuffer';
    this.causa = causa;
  }
}

/** Uma fila de operações sobre um SourceBuffer. */
export class FilaDeBuffer {
  /**
   * @param {SourceBuffer} sourceBuffer
   * @param {{guardarAtras?: number}} opcoes quantos segundos manter para trás
   */
  constructor(sourceBuffer, { guardarAtras = 30 } = {}) {
    this.buffer = sourceBuffer;
    this.guardarAtras = guardarAtras;
    this.fila = [];
    this.ocupado = false;
    this.destruido = false;

    this.buffer.addEventListener('updateend', () => this.seguir());
    this.buffer.addEventListener('error', () => this.falhar(new ErroDeBuffer('O SourceBuffer relatou erro')));
  }

  /** Acrescenta bytes, esperando a vez. */
  acrescentar(bytes) {
    return this.enfileirar(() => this.buffer.appendBuffer(bytes));
  }

  /** Remove um trecho, esperando a vez. */
  remover(de, ate) {
    if (!(ate > de)) return Promise.resolve();

    return this.enfileirar(() => this.buffer.remove(de, ate));
  }

  enfileirar(operacao) {
    if (this.destruido) return Promise.reject(new ErroDeBuffer('A fila já foi destruída'));

    return new Promise((cumprir, rejeitar) => {
      this.fila.push({ operacao, cumprir, rejeitar });
      this.seguir();
    });
  }

  seguir() {
    if (this.ocupado || this.destruido) return;

    // `updating` é a única fonte de verdade sobre se dá para chamar agora.
    if (this.buffer.updating) return;

    const proxima = this.fila.shift();

    if (!proxima) return;

    this.ocupado = true;

    try {
      proxima.operacao();

      // O `updateend` chega depois; até lá a operação segue pendente.
      const aoTerminar = () => {
        this.buffer.removeEventListener('updateend', aoTerminar);
        this.ocupado = false;
        proxima.cumprir();
        this.seguir();
      };

      this.buffer.addEventListener('updateend', aoTerminar);
    } catch (erro) {
      this.ocupado = false;

      if (erro?.name === 'QuotaExceededError') {
        // Encheu. Devolver a operação para a fila depois de limpar o passado
        // é o que faz um vídeo longo continuar tocando em vez de morrer na
        // metade.
        this.fila.unshift(proxima);
        this.limparPassado().then(() => this.seguir(), (falha) => proxima.rejeitar(falha));

        return;
      }

      proxima.rejeitar(new ErroDeBuffer(`Falha ao mexer no buffer: ${erro?.message ?? erro}`, erro));
      this.seguir();
    }
  }

  /** Apaga o que já passou, deixando uma folga para trás. */
  async limparPassado(instanteAtual = null) {
    const faixas = this.buffer.buffered;

    if (faixas.length === 0) return;

    const agora = instanteAtual ?? this.instanteAtual ?? 0;
    const limite = agora - this.guardarAtras;

    if (limite <= faixas.start(0)) return;

    await this.remover(faixas.start(0), limite);
  }

  falhar(erro) {
    for (const pendente of this.fila.splice(0)) pendente.rejeitar(erro);

    this.ocupado = false;
  }

  /** Descarta tudo. */
  destruir() {
    this.destruido = true;
    this.falhar(new ErroDeBuffer('A fila foi destruída'));
  }
}

/**
 * Quantos segundos já estão carregados a partir de um instante.
 *
 * Um `TimeRanges` pode ter buracos — um salto na linha do tempo cria uma faixa
 * nova em vez de estender a anterior. Só a faixa que **contém** o instante
 * atual conta; somar todas daria um número tranquilizador e errado, e o vídeo
 * pararia no primeiro buraco.
 */
export function bufferAdiante(faixas, instante) {
  if (!faixas || faixas.length === 0) return 0;

  for (let i = 0; i < faixas.length; i += 1) {
    const inicio = faixas.start(i);
    const fim = faixas.end(i);

    // A tolerância cobre a imprecisão de ponto flutuante entre a posição
    // relatada pelo vídeo e a fronteira da faixa.
    if (instante >= inicio - 0.1 && instante < fim) return fim - instante;
  }

  return 0;
}

/** Se um instante já está carregado. */
export function estaCarregado(faixas, instante) {
  return bufferAdiante(faixas, instante) > 0;
}

/** As faixas como lista, para depuração e teste. */
export function faixasComoLista(faixas) {
  const lista = [];

  for (let i = 0; i < (faixas?.length ?? 0); i += 1) {
    lista.push({ inicio: faixas.start(i), fim: faixas.end(i) });
  }

  return lista;
}
