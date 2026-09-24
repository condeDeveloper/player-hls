/**
 * A escolha de qualidade.
 *
 * É a parte do HLS que ninguém vê funcionando e todo mundo percebe quando
 * falha — o vídeo que trava, ou o que fica borrado numa conexão boa.
 *
 * O laço é simples de descrever e cheio de cuidado no detalhe: mede quanto
 * tempo o último segmento levou para chegar, estima a banda, e escolhe a maior
 * variante que caiba nela. Cada cuidado abaixo existe por um sintoma concreto.
 */

/**
 * A estimativa de banda por média exponencial.
 *
 * Uma média simples de todas as amostras demora demais para reagir: entrar no
 * elevador derruba a conexão e o player continua pedindo 1080p por mais um
 * minuto. Uma média só da última amostra reage rápido demais: um segmento que
 * veio do cache do navegador em 5 ms sugere uma banda de 400 Mbps, e o player
 * salta para a qualidade máxima e trava logo em seguida.
 *
 * A média exponencial fica no meio, e com **duas** constantes: uma rápida e
 * uma lenta. A estimativa usada é a **menor das duas** — porque errar para
 * baixo faz o vídeo ficar um pouco pior, e errar para cima faz ele parar.
 */
export class EstimadorDeBanda {
  /**
   * @param {{rapida?: number, lenta?: number, inicial?: number}} opcoes
   *   As meias-vidas em número de amostras, e a estimativa antes da primeira.
   */
  constructor({ rapida = 3, lenta = 9, inicial = 1_000_000, tempoMinimo = 50 } = {}) {
    this.rapida = rapida;
    this.lenta = lenta;
    this.inicial = inicial;
    this.tempoMinimo = tempoMinimo;
    this.mediaRapida = null;
    this.mediaLenta = null;
    this.amostras = 0;
    this.ultimaAmostra = null;
  }

  /**
   * Registra um segmento baixado.
   *
   * @param {number} bytes quantos bytes vieram
   * @param {number} milissegundos quanto tempo levou
   */
  registrar(bytes, milissegundos) {
    if (!(bytes > 0) || !(milissegundos > 0)) return this.estimativa();

    // Um segmento que chegou em menos de alguns milissegundos veio do cache,
    // não da rede: ele mede a memória do navegador. Meio megabyte em 5 ms
    // "prova" 800 Mbps, e o player salta para a qualidade máxima e trava no
    // segmento seguinte — que aí vem da rede de verdade.
    if (milissegundos < this.tempoMinimo) {
      this.descartadas = (this.descartadas ?? 0) + 1;

      return this.estimativa();
    }

    const bitsPorSegundo = (bytes * 8) / (milissegundos / 1000);

    this.ultimaAmostra = bitsPorSegundo;
    this.amostras += 1;

    this.mediaRapida = this.misturar(this.mediaRapida, bitsPorSegundo, this.rapida);
    this.mediaLenta = this.misturar(this.mediaLenta, bitsPorSegundo, this.lenta);

    return this.estimativa();
  }

  misturar(atual, valor, meiaVida) {
    if (atual === null) return valor;

    const peso = 1 / meiaVida;

    return atual * (1 - peso) + valor * peso;
  }

  /** A estimativa atual, em bits por segundo. */
  estimativa() {
    if (this.mediaRapida === null) return this.inicial;

    // A menor das duas: subestimar dá vídeo pior, superestimar dá vídeo parado.
    return Math.min(this.mediaRapida, this.mediaLenta);
  }

  /** Esquece tudo — usado quando a mídia troca. */
  esquecer() {
    this.mediaRapida = null;
    this.mediaLenta = null;
    this.amostras = 0;
    this.ultimaAmostra = null;
  }
}

/**
 * Escolhe a variante.
 *
 * Três regras, e cada uma corrige um comportamento visível:
 *
 * 1. **Margem de segurança.** Usar 100% da banda estimada não deixa folga para
 *    a variação normal da rede; o segmento seguinte chega atrasado e o vídeo
 *    trava. O padrão usa 80%.
 * 2. **Subir exige mais do que descer.** Sem isso o player oscila entre duas
 *    qualidades a cada segmento, e a troca constante é mais incômoda do que
 *    ficar na qualidade menor. Subir pede que a banda cubra a variante com
 *    folga; descer acontece assim que ela não cobre.
 * 3. **Buffer curto manda mais que banda.** Com menos de alguns segundos
 *    acumulados, o risco é parar agora — e aí a qualidade cai
 *    independentemente do que a estimativa diga.
 */
export class Adaptador {
  /**
   * @param {object[]} variantes as variantes, da menor para a maior banda
   * @param {{margem?: number, folgaParaSubir?: number, bufferMinimo?: number}} opcoes
   */
  constructor(variantes, { margem = 0.8, folgaParaSubir = 1.3, bufferMinimo = 6 } = {}) {
    if (!Array.isArray(variantes) || variantes.length === 0) {
      throw new TypeError('O adaptador precisa de pelo menos uma variante.');
    }

    this.variantes = [...variantes].sort((a, b) => a.banda - b.banda);
    this.margem = margem;
    this.folgaParaSubir = folgaParaSubir;
    this.bufferMinimo = bufferMinimo;
    this.atual = 0;
    this.travada = null;
  }

  /** Fixa uma qualidade, desligando a escolha automática. */
  travar(indice) {
    if (indice === null) {
      this.travada = null;

      return this;
    }

    if (!Number.isInteger(indice) || indice < 0 || indice >= this.variantes.length) {
      throw new RangeError(`Variante ${indice} não existe (há ${this.variantes.length}).`);
    }

    this.travada = indice;
    this.atual = indice;

    return this;
  }

  /** Se a escolha está automática. */
  get automatico() {
    return this.travada === null;
  }

  /** A variante em uso. */
  get variante() {
    return this.variantes[this.atual];
  }

  /**
   * Decide qual variante usar agora.
   *
   * @param {{banda: number, bufferAdiante?: number}} situacao
   * @returns {number} o índice escolhido
   */
  escolher({ banda, bufferAdiante = Infinity }) {
    if (this.travada !== null) return this.travada;

    const disponivel = banda * this.margem;

    // Buffer curto: o risco é parar agora, e a menor qualidade é a que chega
    // mais rápido. Nenhuma estimativa de banda vale mais do que isso.
    if (bufferAdiante < this.bufferMinimo && this.atual > 0) {
      this.atual = Math.max(0, this.atual - 1);

      return this.atual;
    }

    let escolhida = 0;

    for (let i = 0; i < this.variantes.length; i += 1) {
      const exigencia = i > this.atual ? this.variantes[i].banda * this.folgaParaSubir : this.variantes[i].banda;

      if (exigencia <= disponivel) escolhida = i;
    }

    this.atual = escolhida;

    return escolhida;
  }

  /** A variante mais próxima de uma altura de tela, para a escolha manual. */
  maisProximaDe(altura) {
    let melhor = 0;
    let menorDiferenca = Infinity;

    for (let i = 0; i < this.variantes.length; i += 1) {
      const resolucao = this.variantes[i].resolucao;

      if (!resolucao) continue;

      const diferenca = Math.abs(resolucao.altura - altura);

      if (diferenca < menorDiferenca) {
        menorDiferenca = diferenca;
        melhor = i;
      }
    }

    return melhor;
  }

  /** As qualidades, como a interface mostra. */
  rotulos() {
    return this.variantes.map((v, i) => ({
      indice: i,
      nome: v.nome ?? (v.resolucao ? `${v.resolucao.altura}p` : `${Math.round(v.banda / 1000)} kbps`),
      banda: v.banda,
      resolucao: v.resolucao,
    }));
  }
}
