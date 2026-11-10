# Minas em Alerta

Protótipo web para explorar os acidentes de 2026 em Minas Gerais sem inventar ocorrências. O mapa e os filtros de ocorrências usam a base da PRF; os registros da SEJUSP são mostrados separadamente como totais de vítimas por município, pois essa base não descreve a rodovia nem a causa de cada acidente.

## Executar

Sirva a pasta por HTTP (o mapa vetorial não pode ser carregado abrindo `index.html` diretamente):

```powershell
python -m http.server 8000
```

Abra `http://localhost:8000`.

## Dados disponíveis no deploy

Os arquivos [`data/prf-2026.json`](./data/prf-2026.json) e [`data/sejusp-2026.json`](./data/sejusp-2026.json) são snapshots estáticos das fontes oficiais, incluídos no repositório. Ao publicar a pasta na Vercel, qualquer visitante recebe os dados automaticamente ao abrir o site; não precisa importar arquivos. O navegador baixa esses JSONs públicos diretamente da hospedagem estática. Não há servidor de aplicação, API própria ou envio de dados pessoais dos visitantes.

Os snapshots representam o último conjunto oficial usado para gerar a publicação, não dados em tempo real. A PRF atualiza a planilha mensalmente; a atualização da SEJUSP também depende da publicação da fonte. Para publicar uma versão mais recente:

1. Abra a página oficial de [Dados Abertos da PRF](https://www.gov.br/prf/pt-br/acesso-a-informacao/dados-abertos/dados-abertos-da-prf) e baixe **Acidentes 2026 (agrupados por ocorrência)**.
2. Baixe o CSV 2026 de [Vítimas de Acidente de Trânsito da SEJUSP](https://dados.mg.gov.br/dataset/sejusp_vitimas_acidentes_transito).
3. Gere os snapshots com Python: `python scripts/generate_data.py --prf "caminho\datatran2026.zip" --sejusp "caminho\vitimas_acidente_transito_2026.csv"`.
4. Revise as alterações em `data/` e publique um novo deploy da Vercel. O gerador também aceita o CSV da PRF extraído, em vez do ZIP.

O site não oferece importação manual de CSV: para atualizar os dados disponíveis aos visitantes, gere snapshots novos e publique outro deploy.

## Fontes e limitações

- **PRF:** base de acidentes agrupada por ocorrência, atualizada mensalmente e com coordenadas, rodovia, horário, causa, tipo e vítimas. Abrange rodovias federais (BRs), não todas as rodovias estaduais.
- **SEJUSP-MG:** base estadual de vítimas provenientes dos registros REDS. O protótipo apresenta os registros por município, sem atribuir causa, rodovia ou ponto individual que não esteja confirmado.
- **Limites municipais:** [geodata-br](https://github.com/tbrugz/geodata-br), arquivo de Minas Gerais disponibilizado sob licença CC0.

As fontes oficiais podem revisar registros e atualizar os arquivos. O conjunto incluído nesta publicação vai até a data exibida na interface.
