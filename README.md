# player-hls

Um player de HLS escrito do zero em JavaScript puro, sobre **MediaSource
Extensions**: leitura da playlist, busca dos segmentos, gestão do buffer e
troca automática de qualidade conforme a banda. Sem hls.js, sem video.js, sem
dependência nenhuma.

É a peça de reprodução do **CondePlay**.

```js
import { PlayerHls } from 'player-hls';

const player = new PlayerHls(document.querySelector('video'), { bufferAlvo: 30 });

await player.carregar('https://exemplo/filme.m3u8');
await player.prender(PlayerHls.tipoDe(player.adaptador.variante));

player.iniciar();
```

`exemplo/index.html` é uma página de demonstração com medidores de banda,
buffer e qualidade em tempo real, apontando para fluxos públicos de teste.

## Por que existe

Nenhum navegador além do Safari toca `.m3u8` nativamente. Todo player de
streaming na web — sem exceção — baixa os pedaços por conta e os empurra para o
`<video>` através do MediaSource. Escrever isso uma vez explica o formato
inteiro.

### 1. Playlist mestra e playlist de mídia são coisas diferentes

- A **mestra** lista as *qualidades*: cada `#EXT-X-STREAM-INF` descreve uma
  variante e a linha seguinte é a URL da playlist dela.
- A **de mídia** lista os *segmentos*: cada `#EXTINF` diz a duração e a linha
  seguinte é a URL do pedaço de vídeo.

O mesmo arquivo nunca é os dois, e confundi-los leva a tentar reproduzir uma
playlist como se fosse vídeo.

### 2. A vírgula dentro das aspas

```
#EXT-X-STREAM-INF:BANDWIDTH=2149280,CODECS="mp4a.40.2,avc1.64001f"
```

Um `split(',')` ingênuo parte o valor de `CODECS` ao meio — e o resultado é um
player que decide, sozinho, que não sabe tocar nada. É a armadilha mais cara
do formato, e por isso a leitura de atributos aqui é um laço, não um `split`.

### 3. As URLs são relativas à playlist, não à página

Uma playlist em `https://cdn/x/y/mestre.m3u8` com a linha `url_0/baixa.m3u8`
aponta para `https://cdn/x/y/url_0/baixa.m3u8`. Resolver contra o endereço da
página daria em qualquer lugar.

### 4. `appendBuffer` é assíncrono, e a memória acaba

Três comportamentos do `SourceBuffer`, e desrespeitar qualquer um produz o
mesmo `InvalidStateError` inútil:

- Ele volta na hora mas fica `updating` até terminar; chamar de novo antes
  disso lança. Por isso existe uma **fila**.
- Quando a memória enche, vem `QuotaExceededError` — e a resposta certa não é
  desistir, é **apagar o que já passou** e tentar de novo. É o que faz um filme
  longo continuar tocando em vez de morrer na metade.
- Remover também é assíncrono e concorre pela mesma fila.

### 5. O buffer à frente só conta a faixa atual

Um `TimeRanges` tem buracos: um salto na linha do tempo cria uma faixa nova em
vez de estender a anterior. Somar todas daria um número tranquilizador e
errado, e o vídeo pararia no primeiro buraco.

### 6. A adaptação erra de dois jeitos opostos

Uma média de todas as amostras demora demais: entrar no elevador derruba a
conexão e o player continua pedindo 1080p por mais um minuto. Só a última
amostra reage rápido demais.

A saída são **duas médias exponenciais** — uma rápida e uma lenta — e usar a
**menor das duas**, porque subestimar dá vídeo pior e superestimar dá vídeo
parado.

E três regras na escolha:

- **Margem de 80%.** Usar 100% da banda não deixa folga para a variação normal
  da rede.
- **Subir exige 30% a mais; descer não exige nada.** Sem isso o player oscila
  entre duas qualidades a cada segmento, e a troca constante incomoda mais do
  que ficar na menor.
- **Buffer curto manda mais que banda.** Com menos de 6 segundos acumulados, o
  risco é parar agora — e a qualidade cai independentemente da estimativa.

### O bug que o próprio teste pegou

Eu escrevi que as médias exponenciais protegiam contra o segmento que vem do
cache. Não protegiam: 500 KB em 5 ms "provam" 800 Mbps, e o teste mostrou a
estimativa saltando de 4 para **92 Mbps**.

A correção não foi mexer nas constantes, foi reconhecer o que a amostra mede:
um segmento que chega em menos de 50 ms mediu a memória do navegador, não a
rede. Ele é **descartado**.

## A API

```js
// Leitura de playlist, sem player nenhum:
import { ler, lerMestra, lerMidia, segmentoEm } from 'player-hls';

const mestra = lerMestra(texto, urlDaPlaylist);
// { variantes: [{ url, banda, codecs, resolucao, nome }], midiaAlternativa }

const midia = lerMidia(texto, urlDaVariante);
// { segmentos, duracaoAlvo, aoVivo, modo, inicializacao, criptografada, duracaoTotal }

// Adaptação, sem rede nenhuma:
import { Adaptador, EstimadorDeBanda } from 'player-hls';

const banda = new EstimadorDeBanda();

banda.registrar(bytes, milissegundos);

const adaptador = new Adaptador(mestra.variantes);

adaptador.escolher({ banda: banda.estimativa(), bufferAdiante: 12 });
adaptador.travar(0);      // fixa a qualidade
adaptador.travar(null);   // volta ao automático
```

Eventos do player: `qualidades`, `qualidade`, `carregado`, `segmento`,
`salto`, `fim` e `erro`.

## Estrutura

```
src/m3u8.js       o analisador de playlist, mestra e de mídia
src/adaptacao.js  estimativa de banda e escolha de qualidade
src/buffer.js     a fila do SourceBuffer e a conta do buffer à frente
src/player.js     o laço: baixar, decidir, alimentar o <video>
exemplo/          página de demonstração com medidores ao vivo
```

## Rodando

```bash
npm test
```

61 testes. Os 40 do analisador rodam contra **playlists reais**, baixadas dos
fluxos públicos de teste da Mux e da Apple e guardadas em `testes/amostras/`.
Elas trazem sujeira que playlist inventada não teria:

- a da Apple escreve `#EXTINF:9.97667,` seguido de uma **tabulação**, e tem
  **linhas em branco** entre as variantes;
- a da Mux vem com as qualidades **fora de ordem** e com `CODECS` contendo
  vírgula dentro das aspas.

A demonstração precisa de um servidor, porque módulos ES não carregam de
`file://`:

```bash
npx serve -l 5200 .
# depois: http://localhost:5200/exemplo/
```

Node 20 ou mais novo para os testes; qualquer navegador com MediaSource para o
player.

## Limites conhecidos

- **Sem legendas.** `#EXT-X-MEDIA` de tipo `SUBTITLES` é lido, mas nada é
  exibido: renderizar WebVTT sincronizado é outro projeto.
- **Sem faixas de áudio separadas.** Fluxos com áudio em playlist própria
  (`AUDIO="grupo"`) tocam só o vídeo; juntar duas trilhas exige dois
  `SourceBuffer` sincronizados.
- **Sem criptografia.** `#EXT-X-KEY` é detectado e o player recusa o fluxo, em
  vez de tocar ruído. DRM (Widevine, FairPlay) exige licença e não cabe aqui.
- **Ao vivo é reconhecido, mas não recarregado.** Falta o laço que rebusca a
  playlist a cada `TARGETDURATION`.
- **A troca de qualidade não é instantânea.** Ela acontece no próximo segmento;
  trocar no meio exigiria descartar o buffer à frente e reemendar.
- **Sem recuperação de erro.** Um segmento que falha derruba o laço; um player
  de produção tentaria de novo e cairia de qualidade.

## Licença

MIT.
