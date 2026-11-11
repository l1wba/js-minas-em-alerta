# Minas em Alerta

Site estático para explorar os acidentes nas rodovias federais (BRs) de Minas Gerais com dados públicos, sem inventar ocorrências. As ocorrências, o mapa e as estatísticas usam a base da PRF; os registros da SEJUSP aparecem à parte, como totais de vítimas por município, porque essa base não informa a rodovia nem a causa de cada acidente.

Os anos disponíveis vêm de [`data/years.json`](./data/years.json) (nesta publicação, 2022 a 2026).

## O que o site faz

- **Seletor de ano** ao lado do título: troca os dados do mapa, dos cartões e da barra lateral. O ano fica no endereço (por exemplo `#ano=2024`), então o link pode ser compartilhado.
- **Mapa** com o traçado das BRs: passe o mouse sobre uma BR para destacá-la e clique nela (ou no escudo) para ver só os dados dela, com os trechos críticos de 10 km. Ocorrências próximas são agrupadas; clique num grupo para aproximar e num ponto para ver o registro. Pontos no mesmo local abrem uma lista.
- **Barra lateral** com abas: filtros (busca, BR, gravidade, horário, condição do tempo, tipo e causa), ranking de ocorrências por BR e dados estaduais da SEJUSP.
- **Estatísticas** com período próprio (ano do mapa, um ano, todos os anos, últimos 12 meses ou datas De/Até), que não altera o mapa: indicadores, evolução anual, mês a mês, trechos e municípios mais perigosos (clique para ver no mapa), condição do tempo, dia da semana × horário, tipos mais letais e principais causas. Os filtros da barra lateral também valem aqui.
- **Modo claro e escuro**, seguindo o sistema na primeira visita e lembrando a escolha.

## Executar

Requisito: Python 3 (os scripts usam só a biblioteca padrão; nada para instalar).

Sirva a pasta por HTTP (o site não carrega abrindo `index.html` direto no navegador):

```bash
python -m http.server 8000
```

Abra `http://localhost:8000`.

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `index.html`, `styles.css`, `app.js` | O site (HTML, CSS e JavaScript puros, sem build) |
| `data/prf-<ano>.json` | Ocorrências da PRF em MG no ano, já tratadas |
| `data/sejusp-<ano>.json` | Vítimas da SEJUSP por município no ano |
| `data/years.json` | Lista de anos disponíveis, com totais e data dos dados |
| `data/minas-gerais-brs.geojson` | Traçado das BRs (OpenStreetMap, simplificado) |
| `data/minas-gerais-municipios.geojson` | Limites municipais de Minas Gerais |
| `scripts/update_data.py` | Baixa os arquivos oficiais e atualiza `data/` |
| `scripts/generate_data.py` | Gera os snapshots a partir de arquivos já baixados |
| `scripts/build_roads.py` | Gera o traçado das BRs a partir do OpenStreetMap |
| `.github/workflows/update-data.yml` | Atualização automática semanal |

## Dados incluídos no deploy

Os arquivos de `data/` são snapshots estáticos das fontes oficiais, versionados no repositório. Ao publicar a pasta na Vercel, qualquer visitante recebe os dados ao abrir o site, sem importar nada. Não há servidor de aplicação, API própria ou envio de dados pessoais dos visitantes.

O site lê `data/years.json` primeiro e baixa só os arquivos do ano escolhido no mapa. A seção de Estatísticas baixa outros anos quando o período escolhido os inclui e, para a evolução anual, quando a seção se aproxima da tela.

Os snapshots representam o último conjunto oficial publicado, não dados em tempo real. A PRF não oferece API: publica a planilha (ZIP no Google Drive) mais ou menos uma vez por mês. A SEJUSP publica o CSV no portal dados.mg.gov.br.

### Atualização automática

O workflow [`.github/workflows/update-data.yml`](./.github/workflows/update-data.yml) roda toda segunda-feira às 06:00 (horário de Brasília) e também pode ser disparado à mão em **Actions → Atualizar dados PRF e SEJUSP → Run workflow**. Ele executa [`scripts/update_data.py`](./scripts/update_data.py), que:

1. encontra o link **Acidentes &lt;ano&gt; (agrupados por ocorrência)** na página de [Dados Abertos da PRF](https://www.gov.br/prf/pt-br/acesso-a-informacao/dados-abertos/dados-abertos-da-prf) e baixa o ZIP do Google Drive;
2. consulta a API do [dados.mg.gov.br](https://dados.mg.gov.br/dataset/sejusp_vitimas_acidentes_transito) e baixa o CSV do mesmo ano da SEJUSP;
3. gera os snapshots e atualiza `data/years.json`, gravando só o que mudou. Nesse caso o workflow faz um commit em `data/` e a Vercel publica a nova versão.

Por padrão é atualizado só o ano corrente; de janeiro a março, também o ano anterior, que ainda recebe correções. Se a PRF ainda não publicou o arquivo do ano novo, ele é ignorado com um aviso; quando aparecer, o ano entra sozinho no seletor do site. Os anos antigos não são removidos.

Proteções: se o link sumir ou o arquivo vier inválido, o workflow falha sem alterar nada e o GitHub envia um e-mail de falha. Também falha se a nova base da PRF tiver mais de 10% menos ocorrências que a atual. Se aparecer uma BR sem traçado no mapa, o log mostra um aviso para regenerar o traçado.

Para rodar localmente:

```bash
python scripts/update_data.py
```

Para baixar anos específicos (por exemplo, ao incluir anos anteriores):

```bash
python scripts/update_data.py --years 2022 2023 2024 2025 2026
```

### Atualização manual (alternativa)

1. Baixe **Acidentes &lt;ano&gt; (agrupados por ocorrência)** da PRF e o CSV do mesmo ano da SEJUSP.
2. Gere os snapshots desse ano (aceita o ZIP ou o CSV da PRF extraído); `data/years.json` é atualizado junto:

   ```bash
   python scripts/generate_data.py --year 2026 --prf "caminho/datatran2026.zip" --sejusp "caminho/vitimas_acidente_transito_2026.csv"
   ```

3. Revise as alterações em `data/` e publique.

### Traçado das BRs

Se surgir uma BR nova na base da PRF, regenere o traçado (consulta o OpenStreetMap pela API Overpass e grava `data/minas-gerais-brs.geojson`):

```bash
python scripts/build_roads.py
```

O Overpass às vezes recusa por sobrecarga; o script tenta de novo sozinho. Para não repetir o download, `--save-osm arquivo.json` guarda a resposta e `--osm arquivo.json` a reaproveita.

## Fontes e limitações

- **PRF:** acidentes agrupados por ocorrência, atualizados mensalmente, com coordenadas, rodovia, km, horário, causa, tipo, clima e vítimas. Cobre só o que a PRF atende: trechos de BR administrados pelo estado (atendidos pela Polícia Militar Rodoviária) quase não aparecem, por isso algumas BRs, como a BR-265, a BR-352, a BR-367 e a BR-494, têm pouquíssimos registros. Ocorrências sem rodovia informada vêm como "BR-000" e aparecem no mapa sem traçado.
- **SEJUSP-MG:** vítimas registradas no REDS. O site mostra os totais por município, sem atribuir causa ou rodovia.
- **Traçado das BRs:** [OpenStreetMap](https://www.openstreetmap.org/copyright) (© colaboradores do OSM, licença ODbL), simplificado por `scripts/build_roads.py`. O script usa a sigla da via, as relações de rota do OSM e trechos em obras. Onde duas BRs dividem a mesma pista e o OSM registra só uma sigla, o vão é completado com o traçado da outra BR quando há acidentes da PRF com aquele número no trecho (ou quando a ligação é curta e direta). Alguns vãos permanecem onde a rodovia não existe ou não está mapeada, como o trecho planejado da BR-251 no noroeste de Minas.
- **Limites municipais:** [geodata-br](https://github.com/tbrugz/geodata-br), arquivo de Minas Gerais sob licença CC0.

As fontes oficiais podem revisar registros e atualizar os arquivos. Os dados incluídos nesta publicação vão até a data exibida na interface.
