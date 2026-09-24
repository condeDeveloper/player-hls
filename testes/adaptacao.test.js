import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Adaptador, EstimadorDeBanda } from '../src/adaptacao.js';
import { bufferAdiante, estaCarregado, faixasComoLista } from '../src/buffer.js';

/** As variantes da playlist real da Mux, já ordenadas. */
const VARIANTES = [
  { banda: 246_440, resolucao: { largura: 320, altura: 184 }, nome: '240' },
  { banda: 460_560, resolucao: { largura: 512, altura: 288 }, nome: '380' },
  { banda: 836_280, resolucao: { largura: 848, altura: 480 }, nome: '480' },
  { banda: 2_149_280, resolucao: { largura: 1280, altura: 720 }, nome: '720' },
  { banda: 6_221_600, resolucao: { largura: 1920, altura: 1080 }, nome: '1080' },
];

/** Um `TimeRanges` de mentira, que é o que o `<video>` devolve. */
function faixas(...pares) {
  return {
    length: pares.length,
    start: (i) => pares[i][0],
    end: (i) => pares[i][1],
  };
}

describe('estimativa de banda', () => {
  it('antes da primeira amostra usa o valor inicial', () => {
    assert.equal(new EstimadorDeBanda({ inicial: 500_000 }).estimativa(), 500_000);
  });

  it('a primeira amostra vira a estimativa', () => {
    const estimador = new EstimadorDeBanda();

    // 1 MB em 1 s = 8 Mbps.
    estimador.registrar(1_000_000, 1000);

    assert.equal(Math.round(estimador.estimativa()), 8_000_000);
  });

  it('fica com a menor das duas médias', () => {
    // Errar para baixo dá vídeo pior; errar para cima dá vídeo parado.
    const estimador = new EstimadorDeBanda();

    estimador.registrar(100_000, 1000);
    estimador.registrar(100_000, 1000);
    estimador.registrar(1_000_000, 1000);

    assert.equal(estimador.estimativa(), Math.min(estimador.mediaRapida, estimador.mediaLenta));
    assert.ok(estimador.estimativa() < estimador.ultimaAmostra, 'um pico não arrasta a estimativa junto');
  });

  it('um segmento vindo do cache é descartado, não vira estimativa', () => {
    // 500 KB em 5 ms "provam" 800 Mbps. Isso mede o cache do navegador, não a
    // rede — e aceitar a amostra faz o player saltar para a qualidade máxima
    // e travar no segmento seguinte.
    const estimador = new EstimadorDeBanda();

    for (let i = 0; i < 5; i += 1) estimador.registrar(500_000, 1000);

    const antes = estimador.estimativa();

    estimador.registrar(500_000, 5);

    assert.equal(estimador.estimativa(), antes);
    assert.equal(estimador.descartadas, 1);
  });

  it('a queda de banda é seguida em poucas amostras', () => {
    // Entrar no elevador não pode deixar o player pedindo 1080p por um minuto.
    const estimador = new EstimadorDeBanda();

    for (let i = 0; i < 10; i += 1) estimador.registrar(1_000_000, 1000);

    const antes = estimador.estimativa();

    for (let i = 0; i < 3; i += 1) estimador.registrar(1_000_000, 20_000);

    assert.ok(estimador.estimativa() < antes / 2, `não reagiu: ${antes} → ${estimador.estimativa()}`);
  });

  it('amostra inválida é ignorada', () => {
    const estimador = new EstimadorDeBanda({ inicial: 123 });

    estimador.registrar(0, 1000);
    estimador.registrar(1000, 0);

    assert.equal(estimador.estimativa(), 123);
  });
});

describe('escolha de qualidade', () => {
  it('escolhe a maior que cabe na banda, com margem', () => {
    const adaptador = new Adaptador(VARIANTES);

    // 3 Mbps × 0,8 de margem = 2,4 Mbps. A variante de 2.149.280 caberia,
    // mas subir para ela exige a folga de 30% — que dá 2,79 Mbps. Do começo
    // frio, então, o player fica na de 836.280: é conservador de propósito.
    assert.equal(adaptador.escolher({ banda: 3_000_000 }), 2);

    // Com banda folgada ele chega lá.
    assert.equal(new Adaptador(VARIANTES).escolher({ banda: 4_000_000 }), 3);
  });

  it('banda apertada cai para a menor', () => {
    const adaptador = new Adaptador(VARIANTES);

    assert.equal(adaptador.escolher({ banda: 200_000 }), 0);
  });

  it('subir exige folga; descer não', () => {
    // Sem isso o player oscila entre duas qualidades a cada segmento, e a
    // troca constante incomoda mais do que ficar na menor.
    const adaptador = new Adaptador(VARIANTES, { margem: 1, folgaParaSubir: 1.3 });

    adaptador.atual = 2;

    // Exatamente a banda da variante 3: não sobe, porque falta a folga.
    assert.equal(adaptador.escolher({ banda: 2_149_280 }), 2);

    adaptador.atual = 2;

    // Com 30% a mais, sobe.
    assert.equal(adaptador.escolher({ banda: 2_149_280 * 1.31 }), 3);

    adaptador.atual = 3;

    // Para descer basta não caber.
    assert.equal(adaptador.escolher({ banda: 900_000 }), 2);
  });

  it('buffer curto derruba a qualidade, custe o que disser a banda', () => {
    // O risco é parar agora, e a menor qualidade é a que chega mais rápido.
    const adaptador = new Adaptador(VARIANTES);

    adaptador.atual = 4;

    assert.equal(adaptador.escolher({ banda: 50_000_000, bufferAdiante: 2 }), 3);
  });

  it('travar desliga a escolha automática', () => {
    const adaptador = new Adaptador(VARIANTES);

    adaptador.travar(0);

    assert.equal(adaptador.automatico, false);
    assert.equal(adaptador.escolher({ banda: 100_000_000 }), 0);

    adaptador.travar(null);

    assert.equal(adaptador.automatico, true);
    assert.equal(adaptador.escolher({ banda: 100_000_000 }), 4);
  });

  it('travar numa variante que não existe é recusado', () => {
    const adaptador = new Adaptador(VARIANTES);

    assert.throws(() => adaptador.travar(99), RangeError);
    assert.throws(() => adaptador.travar(-1), RangeError);
  });

  it('sem variante nenhuma o adaptador reclama', () => {
    assert.throws(() => new Adaptador([]), TypeError);
  });

  it('ordena as variantes mesmo recebendo fora de ordem', () => {
    const adaptador = new Adaptador([...VARIANTES].reverse());

    assert.deepEqual(
      adaptador.variantes.map((v) => v.banda),
      VARIANTES.map((v) => v.banda),
    );
  });

  it('acha a variante mais próxima de uma altura', () => {
    const adaptador = new Adaptador(VARIANTES);

    assert.equal(adaptador.maisProximaDe(1080), 4);
    assert.equal(adaptador.maisProximaDe(700), 3);
    assert.equal(adaptador.maisProximaDe(100), 0);
  });

  it('os rótulos saem prontos para a interface', () => {
    const rotulos = new Adaptador(VARIANTES).rotulos();

    assert.equal(rotulos.length, 5);
    assert.equal(rotulos[4].nome, '1080');
    assert.deepEqual(rotulos[4].resolucao, { largura: 1920, altura: 1080 });
  });
});

describe('buffer à frente', () => {
  it('conta só a faixa que contém o instante atual', () => {
    // Somar todas daria um número tranquilizador e errado: o vídeo pararia no
    // primeiro buraco.
    const carregado = faixas([0, 30], [60, 90]);

    assert.equal(bufferAdiante(carregado, 10), 20);
    assert.equal(bufferAdiante(carregado, 45), 0, 'o instante está num buraco');
    assert.equal(bufferAdiante(carregado, 70), 20);
  });

  it('a tolerância cobre a imprecisão de ponto flutuante', () => {
    // A posição relatada pelo vídeo raramente bate exatamente com a fronteira.
    assert.ok(bufferAdiante(faixas([10, 20]), 9.95) > 0);
    assert.equal(bufferAdiante(faixas([10, 20]), 9.5), 0);
  });

  it('sem faixa nenhuma é zero', () => {
    assert.equal(bufferAdiante(faixas(), 0), 0);
    assert.equal(bufferAdiante(null, 0), 0);
  });

  it('estaCarregado responde a pergunta direta', () => {
    const carregado = faixas([0, 30]);

    assert.equal(estaCarregado(carregado, 10), true);
    assert.equal(estaCarregado(carregado, 40), false);
  });

  it('as faixas viram lista para inspeção', () => {
    assert.deepEqual(faixasComoLista(faixas([0, 30], [60, 90])), [
      { inicio: 0, fim: 30 },
      { inicio: 60, fim: 90 },
    ]);

    assert.deepEqual(faixasComoLista(null), []);
  });
});
