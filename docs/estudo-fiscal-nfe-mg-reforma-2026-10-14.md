# Material de estudo e auditoria fiscal — NF-e/NFC-e (MG + Reforma Tributária)

**Data de referência / consulta:** 14/10/2026  
**Escopo do seu sistema (mapeado no monorepo):** Java (`margin-engine`) calcula tributos e monta INI/XML; Node + ACBrLib (`agente-local`) transmite à SEFAZ. Emite NF-e (55), NFC-e (65) e NFS-e. Regimes CRT 1/2/3. IBS/CBS com motor próprio alinhado à calculadora RTC (sem API HTTP ao vivo). UF de referência operacional: MG; destinos: todas.

> **Método:** lei ≠ prática de mercado. Onde a fonte oficial não fechou número, data ou código, está marcado **NÃO CONFIRMADO**. Não use blog/ERP vendor como “lei”; use só como pista para ir ao Portal/Planalto/SEFAZ.

---

## 0. Como usar este material

1. Leia a seção 1 (cronograma) antes de qualquer mudança de cálculo.
2. Confronte o XML de produção com a seção 2 (NT / grupo UB).
3. Rode a matriz da seção 9 contra o segundo motor (calculadora RTC offline + planilha ST/DIFAL).
4. Feche a seção 12 item a item com evidência (XML + print da rejeição/autorização).

---

## 1. Cronograma da transição (2026–2033)

### 1.1 Base normativa (lei)

| Norma | O que faz | Fonte |
|-------|-----------|--------|
| EC 132/2023 | Cria IBS/CBS/IS; ADCT arts. 125–129: transição e extinção de ICMS/ISS em 2033 | [Planalto EMC 132](https://www.planalto.gov.br/ccivil_03/constituicao/emendas/emc/emc132.htm) |
| LC 214/2025 | Regulamenta IBS, CBS e IS; alíquotas de teste 2026; opção SN híbrido | [Planalto LC 214](https://www.planalto.gov.br/ccivil_03/leis/lcp/Lcp214.htm) |
| LC 227/2026 | CGIBS, processo/distribuição do IBS, ITCMD nacional; altera LC 214 | [Planalto LC 227](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp227.htm) |

**Lei vs prática:** a EC/LC fixam *quando* tributos nascem/morrem e *alíquotas de teste*. Datas de *obrigatoriedade de campos no XML* vêm das **Notas Técnicas** do Portal NF-e (podem ser adiadas sem mudar a lei).

### 1.2 Ano a ano (síntese operacional)

| Ano | Obrigatório (lei) | Facultativo / observação | CBS | IBS | ICMS/ISS | ST / DIFAL |
|-----|-------------------|--------------------------|-----|-----|----------|------------|
| **2026** | Obrigações acessórias de destaque IBS/CBS conforme NT vigente; ano de teste | Quem cumpre obrigações acessórias: **dispensa de recolhimento** IBS/CBS (LC 214 art. 348 §1º — confirmar redação consolidada com LC 227). Ambiente Produção Beta RFB a partir de 12/01/2026 | **0,9%** (art. 346 LC 214) | **0,1%** estadual (art. 343 LC 214) | Plenos | Permanecem (ICMS vigente) |
| **2027** | CBS “para valer”; **extinção PIS/COFINS**; IPI a zero fora ZFM (ADCT); Imposto Seletivo | Opção SN: IBS/CBS no DAS **ou** regime regular (híbrido) | Alíquota de referência art. 14 **menos 0,1 p.p.** (art. 347) — **valor numérico cheio: NÃO CONFIRMADO** (Senado/estimativa) | 0,1% (0,05% UF + 0,05% mun., art. 344) | Plenos | Permanecem |
| **2028** | Consolidação CBS/IBS teste residual | — | Mesma lógica art. 347 | 0,1% (art. 344) | Plenos | Permanecem |
| **2029** | Redução ICMS/ISS a **9/10** das alíquotas legais (ADCT art. 128) | — | Referência Senado | Cresce na proporção inversa | 90% | ST/DIFAL ainda existem sobre parcela remanescente de ICMS |
| **2030** | ICMS/ISS a **8/10** | — | Referência | ↑ | 80% | Idem |
| **2031** | ICMS/ISS a **7/10** | — | Referência | ↑ | 70% | Idem |
| **2032** | ICMS/ISS a **6/10** (último ano) | — | Referência | ↑ | 60% | Idem |
| **2033** | **Extinção ICMS e ISS** (ADCT art. 129) | Sistema pleno IBS+CBS(+IS) | Referência plena | Referência plena | Extintos | **Extintos por consequência** (sem ICMS não há ST/DIFAL). Não há artigo da EC que diga “ST acaba em 202X” separado do ICMS — **lei: extinção com o ICMS em 2033** |

### 1.3 Simples Nacional na transição

| Tema | Regra (lei) | Prática / prazo operacional |
|------|-------------|------------------------------|
| Teste 2026 | Arts. 517/519/520 LC 214 (efeitos) tendem a **2027** para SN/MEI; blogs jurídicos argumentam que CRT 1/2/4 **não** entram no teste 0,9%/0,1% em 2026 | **Confirmar com NT vigente + contador:** se o autorizador exige grupo UB para CRT 1 em 2026 mesmo sem alíquota teste |
| Padrão | IBS/CBS **dentro do DAS** | Manual RFB opção regime regular |
| Opção híbrida | Art. 41 §3º LC 214: apurar IBS/CBS no **regime regular** (fora do DAS) | **CONFIRMADO** no PDF oficial (versão 07/10/2026): **01/09/2026 a 30/10/2026** para o 1º semestre/2027. Páginas espelho com 30/09 ficam desatualizadas. |
| Crédito próprio | Com IBS/CBS no DAS: **vedação** de crédito próprio (art. 47 §9º I LC 214) | Cliente B2B no regime regular pode ter crédito “equivalente ao devido via SN” (art. 47 §9º II) — condições legais |
| Trava | Quem recebeu **ressarcimento** de créditos IBS/CBS no ano corrente/anterior **não pode** sair do regime regular (art. 41 §5º) | Impacto de produto: flag irreversível no cadastro |

### 1.4 Fontes — seção 1 (consulta 14/10/2026)

- EC 132/2023: https://www.planalto.gov.br/ccivil_03/constituicao/emendas/emc/emc132.htm  
- LC 214/2025: https://www.planalto.gov.br/ccivil_03/leis/lcp/Lcp214.htm  
- LC 227/2026: https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp227.htm  
- Manual opção SN IBS/CBS (PDF aberto 14/10/2026, versão 07/10/2026): https://www8.receita.fazenda.gov.br/SimplesNacional/Arquivos/manual/Manual%20op%C3%A7%C3%A3o%20regime%20regular%20IBS%20e%20CBS%20no%20Simples%20Nacional.pdf  
- Página espelho RFB (pode estar desatualizada vs PDF): https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/manuais/reforma-tributaria-do-consumo/manual-escolha-regime-ibs-e-cbs-no-simples-nacional  
- Comunicado Produção Beta CBS (RFB, 26/12/2025): portal gov.br/receitafederal (manuais RTC)

---

## 2. Notas Técnicas vigentes (NF-e/NFC-e) — IBS/CBS/IS

### 2.1 Leiaute e grupo novo

| Item | Conteúdo | Fonte |
|------|----------|--------|
| NT principal | **NT 2025.002-RTC** (Reforma Tributária do Consumo) — grupo **UB** (IBS/CBS/IS) no item | Portal / SVRS |
| Versão vigente (PDF aberto) | **v1.52** — Setembro/2026, 94 páginas | [SVRS NT v1.52 PDF](https://dfe-portal.svrs.rs.gov.br/NFE/DownloadArquivoEstatico/?sistema=NFE&tipoArquivo=3&nomeArquivo=NT_2025.002_v1.52_RTC_NF-e_IBS_CBS_IS.pdf) (consulta 14/10/2026) |
| Tabelas | **IT 2025.002 v1.70** (xlsx; abas datadas 2026-09-01): cClassTrib, CST IBS/CBS | SVRS Documentos → IT 2025.002 v.1.70 |
| Campos-chave | `CST` IBS/CBS + `cClassTrib` (ex.: UB13/UB14 na evolução do leiaute); grupos de alíquotas/valores IBS UF/mun e CBS; IS quando aplicável | NT 2025.002 |
| JSON tabelas | Serviços SVRS (`dfe-portal.svrs.rs.gov.br/CFF/Servicos`) — acesso tipicamente com certificado | SVRS |

### 2.2 Cronograma técnico (XML) ≠ cronograma da lei

| Evento | Data (conforme comunicados de out/2026) | Status |
|--------|------------------------------------------|--------|
| Homologação / produção do **pacote** v1.52 (26/10 e 16/11) | Citado em avisos ENCAT/espelhos | **NÃO CONFIRMADO** no PDF da NT (não constam 26/10 nem 16/11) |
| No PDF v1.52: VC02-50 homologação / produção | até **05/10/2026** / até **03/11/2026** | NT v1.52 p.6 |
| No PDF v1.52: VC02-14 produção | **03/11/2026** (adiada de 05/10) | NT v1.52 p.6 |
| Regra **UB12-10** — homologação CRT 3 | NFe dhEmi ≥ **01/07/2026** | NT v1.52 p.40 Obs. 1 |
| UB12-10 em **produção** | **Implementação futura** (Obs. 2 produção CRT3 03/08/2026 substituída) | NT v1.52 p.5 e p.40 |
| Rejeição associada | **cStat 1115** — “Grupo IBSCBS não informado” | NT v1.52 p.40 |

**CONFIRMADO no PDF:** lista ampla de rejeições **11xx** (1100–1199) com mensagens no corpo da NT; vigência de cada RV segue o cronograma/observações (“implementação futura” em várias).

### 2.3 Outras NTs “clássicas” ainda relevantes

| NT / doc | Efeito prático | Observação |
|----------|----------------|------------|
| MOC 7.0 Anexo I | Regras de validação e rejeições 5xx/6xx | [CONFAZ MOC](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-anexo-i-leiaute-e-rv.pdf) |
| NT históricas (ex. 2015.003 DIFAL, 2016.002 FCP, etc.) | Campos ICMS UF dest / FCP | Continuar vigentes enquanto houver ICMS |
| Informe Técnico 2025.002 (tabelas) | cClassTrib ↔ CST ↔ indicadores por modelo (NFe/NFCe/CTe/NFSe) | Atualizar catálogo versionado no ERP |

### 2.4 Fontes — seção 2

- Portal NF-e: https://www.nfe.fazenda.gov.br/  
- Portal DFe SVRS: https://dfe-portal.svrs.rs.gov.br/  
- Calculadora classificações: https://consumo.tributos.gov.br/servico/calcular-tributos-consumo/calculadora/classificacoes-tributarias  
- Consulta 14/10/2026: comunicados de calendário NT espelhados por TOTVS/Contábeis a partir do Portal (05/10/2026); IT 2025.002 v1.70 (01/10/2026)

---

## 3. ICMS em Minas Gerais (RICMS/2023)

### 3.1 Alíquotas (visão operacional)

| Tipo | Valor usual | Fonte / cuidado |
|------|-------------|-----------------|
| Interna padrão (mercadorias gerais) | **18%** (Parte 1 Anexo I RICMS/2023 — item amplamente citado como 7.1 / operações gerais) | [Anexo I SEF/MG](https://www.fazenda.mg.gov.br/empresas/legislacao_tributaria/ricms_2023_seco/anexoi2023_2.html) — **validar item exato no HTML oficial** |
| Interestadual | **7%** ou **12%** (Resolução Senado 22/1989 e alterações; 4% para produtos importados Resol. 13/2012) | Senado / Convênios — **não inventar tabela UF×UF aqui**; use tabela do sistema versionada |
| FECOP / FEM | Adicional **2%** sobre lista de “supérfluos” (Lei 24.471/2023; Decreto 48.736/2023; efeitos **01/01/2024**) | SEF/MG + lei estadual |
| Energia, cesta, etc. | Alíquotas reduzidas 6%/7%/12% com **data de eficácia** no Anexo I | Sempre ler coluna “EFICÁCIA” |

**Prática de mercado:** muitos ERPs gravam “18% MG” fixo e esquecem benefícios do Anexo II (redução de base) e listas FEM — isso gera DIFAL/ST errados e autuação, não só rejeição.

### 3.2 Substituição tributária (Anexo VII)

| Elemento | Onde está | Nota |
|----------|-----------|------|
| Hipóteses / responsabilidade / restituição | Anexo VII Parte 1 | RICMS/2023 |
| Lista NCM/CEST + MVA | Anexo VII Parte 2 | Atualizações por Decreto (ex.: Decreto 48.743/2023 citado para MVA autopeças 71,78%) |
| Pauta / PMPF | Legislação específica + portarias | **NÃO CONFIRMADO** lista completa neste material — consultar SEF |
| Como a SEFAZ publica | Site SEF/MG → Legislação tributária → RICMS/2023 (HTML por anexo) + DOE-MG | Assinar DOE / feed de decretos |

### 3.3 Benefícios comuns (Anexo II)

Reduções de base (máquinas agrícolas, etc.) com percentuais distintos para interna × interestadual — PDF oficial:  
https://www.fazenda.mg.gov.br/empresas/legislacao_tributaria/ricms2023/anexoii2023.pdf  

### 3.4 Fontes — seção 3

- RICMS/2023 portal SEF/MG: https://www.fazenda.mg.gov.br/empresas/legislacao_tributaria/  
- Consulta 14/10/2026

---

## 4. DIFAL

### 4.1 Marcos legais

| Norma | Papel |
|-------|--------|
| EC 87/2015 | DIFAL para consumidor final **não contribuinte** interestadual |
| LC 190/2022 | Lei complementar exigida pelo STF; vacatio; efeitos em MG a partir de **05/04/2022** (Comunicado SUTRI 001/2022) |
| Convênio ICMS **236/2021** | Procedimentos; **base única** = valor da operação (cláusula 2ª §1º); FCP na alíquota interna de destino (§4º) |
| Convênio 93/2015 | Revogado pelo 236/21 |

### 4.2 Base única vs base dupla

| Hipótese | Base | Fórmula conceitual |
|----------|------|--------------------|
| Destinatário **não contribuinte** (EC 87 / Conv. 236) | **Única** = valor da operação | `ICMS_destino = BC × alíq_interna_dest` ; `ICMS_origem = BC × alíq_inter` ; `DIFAL = ICMS_destino − ICMS_origem` |
| Destinatário **contribuinte** (aquisição) | Em vários Estados: **base dupla** (LC 87 alterada pela LC 190 — art. sobre diferencial devido pelo contribuinte) | **Prática:** seguir legislação da **UF de destino**. Não aplicar base dupla de B2B em NFC-e B2C |

### 4.3 Exemplo numérico — base única (B2C interestadual)

**Dados:** Emitente MG → destinatário consumidor final SP (não contribuinte).  
Valor operação (BC) = **R$ 1.000,00**  
Alíq. interestadual = **12%**  
Alíq. interna SP = **18%**  
FCP SP = **NÃO CONFIRMADO neste exemplo** (depende da mercadoria/lista SP) — se 2%: incluir na “alíquota interna total” do destino conforme Conv. 236 §4º.

**Cálculo sem FCP:**

1. ICMS total à carga do destino: `1000 × 0,18 = 180,00`  
2. ICMS origem: `1000 × 0,12 = 120,00`  
3. **DIFAL = 180 − 120 = 60,00**

**Com FCP 2% (ilustrativo):**

1. Carga destino: `1000 × 0,20 = 200,00`  
2. Origem: `120,00`  
3. DIFAL ICMS “puro” + FCP: separar conforme tags XML (`vICMSUFDest`, `vFCPUFDest`) — **partilha de campos no XML ≠ partilha 2016–2018** (partilha progressiva EC 87 já encerrada; hoje DIFAL integral ao destino).

### 4.4 CST 20 (redução de base) + DIFAL — PENDENTE DE CONFIRMAÇÃO COM XML REAL

1. Aplicar redução de BC conforme benefício da **UF de destino** e Convênio 153/2015 (cláusula 2ª §5º do 236/21).  
2. Há **duas aritméticas em circulação** — **não tratar nenhuma como definitiva** sem XML autorizado da UF destino:

| Modo | Fórmula (BC reduzida 700; 12% / 18%) | Resultado | Status |
|------|--------------------------------------|-----------|--------|
| Por fora / base única sobre BC reduzida | `700 × (18−12)/100` | **42,00** | Uma leitura possível; **NÃO** é esperado oficial do ERP |
| Base reduzida “por dentro” (tributos-br / NF-e SEFAZ-MG citada) | `BC_dest = 700/(1−0,18) = 853,66`; dest 153,66; origem 84,00 | **69,66** | Implementado no motor como `BASE_REDUZIDA_POR_DENTRO`, **desligado por default** |

3. **Motor hoje (entrada):** `DifalUfPoliticaCatalog` — MG = `BASE_DUPLA_POR_DENTRO`; demais = `SIMPLES`. Conjunto de UFs com `BASE_REDUZIDA_POR_DENTRO` para CST 20 inicia **vazio**. Override por UF via `definirModo`.  
4. **Teste T04:** marcado **PENDENTE DE CONFIRMAÇÃO COM XML REAL** — listar UFs da carteira com CST 20 e validar cada uma.

### 4.5 O que MG exige (operacional)

- Exigência DIFAL pós-LC 190: **05/04/2022** (SUTRI 001/2022).  
- Escrituração EFD: manual DIFAL MG (recolhimento por operação pode ser “débito especial”; devolução → restituição, não crédito automático) — Portal SPED MG.  
- IE de substituto / cadastro destino: conforme legislação MG e Conv. 236 cláusula 6ª.

### 4.6 Fontes — seção 4

- Convênio 236/21: https://www.confaz.fazenda.gov.br/legislacao/convenios/2021/CV236_21  
- SUTRI 001/2022: https://www.fazenda.mg.gov.br/empresas/legislacao_tributaria/comunicados/2022/csutri_001_2022.html  
- LC 190/2022: Planalto  
- Consulta 14/10/2026

---

## 5. ICMS-ST

### 5.1 Cenários

| Cenário | CST típico (Regime Normal) | CSOSN típico (SN) | Cálculo na saída |
|---------|----------------------------|-------------------|------------------|
| Substituto (retém ST) | 10, 30, 70… | 201, 202, 203 | Calcula `vBCST`, `vICMSST`, FCP-ST |
| ST retido anteriormente | **60** | **500** | Não recalcula ST; informa `vBCSTRet`, `vICMSSTRet` (e campos de efetivo quando exigidos) |
| Interestadual **com** protocolo/convênio | Depende | Depende | MVA **ajustada** + alíq. interna destino |
| Interestadual **sem** protocolo | — | — | Em regra **não** há ST interestadual; operação com ICMS próprio / outras regras — **confirmar produto×UF** |
| Interno MG | Anexo VII | — | MVA original do anexo |

### 5.2 Fórmula MVA ajustada (padrão Confaz / prática)

\[
MVA_{ajustada} = \left[\left(1 + \frac{MVA_{original}}{100}\right) \times \frac{1 - alíq_{inter}/100}{1 - alíq_{interna\ dest}/100} - 1\right] \times 100
\]

**Exemplo:** MVA orig. 40%; alíq inter 12%; alíq interna dest 18%

1. `(1 + 0,40) = 1,40`  
2. `(1 - 0,12)/(1 - 0,18) = 0,88/0,82 ≈ 1,0731707`  
3. `1,40 × 1,0731707 ≈ 1,502439`  
4. `MVA_aj = (1,502439 - 1) × 100 ≈ **50,2439%**`

**FECOP/FEM/FCP no denominador:** o motor **default NÃO** soma o fundo à alíquota interna (`MvaAjustePoliticaCatalog` inicia vazio). Algumas UFs, na prática, usam `alíq_interna + FECOP` no denominador (diferença ~4 p.p. na MVA). **NÃO CONFIRMADO** quais UFs da carteira exigem isso — confirmar UF a UF com contador/SEFAZ. Parâmetro: `calcularMvaAjustada(..., aliquotaFundo, incluirFundoNoDenominador)`.

### 5.3 Base ST e IPI

**Prática amplamente adotada (Convênios ST):**  
`BC_ST = (valor operação + IPI + frete + seguro + outras − descontos) × (1 + MVA/100)`  
depois `ICMS_ST = BC_ST × alíq_interna − ICMS_próprio`.

**ICMS próprio (revenda):** frete (e seguro/outras) **entra** na base própria; **IPI não entra** (LC 87/96 art. 13 §1º).  
`ICMS_próprio = (vProd − desconto + frete + seguro + outras) × alíq_interestadual`.

**Exemplo corrigido (14/10/2026):** Valor 1000; frete 50; IPI 100; MVA 40%; alíq inter 12%; interna 18%.

1. Base própria: `1000 + 50 = 1050` → `ICMS_próprio = 1050 × 0,12 = **126,00**`  
2. Base operação p/ ST: `1000 + 50 + 100 = 1150`  
3. `BC_ST = 1150 × 1,40 = 1610`  
4. `ICMS_ST = 1610 × 0,18 − 126 = 289,80 − 126 = **163,80**`  

(O valor antigo **169,80** usava próprio 120 sobre 1000 — inconsistente com frete na ST.)

**FCP-ST:** adicional sobre BC_ST ou sobre base própria do fundo — **seguir UF de destino** (MG: FEM na lista).

### 5.4 Ressarcimento / Complementação

MG: Anexo VII — seções de restituição e complementação por não definitividade da BC presumida (arts. citados no índice do Anexo VII).  
**Software:** não “zerar” ST retido em devolução sem evento/ajuste documental.

### 5.5 Fontes — seção 5

- Anexo VII RICMS/2023: https://www.fazenda.mg.gov.br/empresas/legislacao_tributaria/ricms_2023_seco/anexovii2023_1.html  
- Convênios/protocolos ST no CONFAZ  
- Consulta 14/10/2026

---

## 6. Regras por regime (CRT 1, 2, 3)

| CRT | Significado | ICMS no XML | PIS/COFINS (até 2026) | IBS/CBS (transição) |
|-----|-------------|-------------|------------------------|---------------------|
| **1** | Simples Nacional | **CSOSN** (102, 103, 300, 400, 500, 900, 201…) — **não** misturar CST 00/20 | Dentro do DAS (não destaca PIS/COFINS “cheios” como LP/LR) | Padrão: no DAS a partir dos efeitos SN; opção híbrida art. 41 §3º |
| **2** | Simples — excesso sublimite | Regras híbridas / ICMS “normal” em parte das operações | Ver LC 123 + legislação estadual | Controvérsia sobre teste 2026 (ver §1.3) — **confirmar NT** |
| **3** | Regime normal (Presumido/Real) | **CST** 00, 10, 20, 40, 41, 50, 51, 60, 70, 90… | Cumulativo (Presumido) vs não cumulativo (Real) — Lei 10.637/10.833 e alterações | Sujeito ao regime regular IBS/CBS; destaque UB conforme NT |

**CSOSN que muda cálculo:**  
- 102/103: sem crédito / isento — sem ICMS próprio destacado como CST 00.  
- 201/202/203: com ST.  
- 500: ST retido.  
- 900: outros.

**PIS/COFINS:** em 2027 extintos (ECS/ADCT + LC 214) → CBS assume. Em 2026 ainda coexistentes com destaque teste CBS/IBS.

**Cadastro (confirmado no código 14/10/2026):** além do CRT, o tenant guarda `regime_tributario` (`LUCRO_PRESUMIDO` × `LUCRO_REAL`). `FiscalPisCofinsPorRegime` aplica 0,65%/3% (cumulativo, sem crédito) vs 1,65%/7,60% (não cumulativo, com crédito). Armadilha nº 16: **já mitigada no Java**; o fallback do `agente-local` (acbr.js) ainda assume rates Presumido se o payload não trouxer pPis/pCofins — **não alterado neste escopo**.

---

## 7. Arredondamento e precisão

### 7.1 Regra operacional (MOC)

| Campo | Tipo típico | Precisão |
|-------|-------------|----------|
| `vUnCom` / `vUnTrib` | decimal | até muitas casas (schema) |
| `vProd`, bases, impostos | monetário | **2 casas** |
| Multiplicação `qCom × vUnCom` | RV **I11-10 / rejeição 629** | Arredondar produto a 2 casas; **tolerância ± R$ 0,01** (nota *4 do MOC) |
| Totais `ICMSTot` | soma dos itens | Rejeições 5xx se divergir |

**Lei vs prática:** a SEFAZ valida o **XML serializado**, não a planilha interna. Arredonde **depois** da multiplicação; não arredonde unitário cedo demais.

### 7.2 Rejeições de cálculo (mais comuns)

| cStat | Mensagem (resumo) | Causa mais comum |
|-------|-------------------|------------------|
| **629** | vProd ≠ qCom × vUnCom | Peso/qtd com muitas casas; unitário truncado |
| **630** | vProd ≠ qTrib × vUnTrib | Fator de conversão errado |
| **531** | Total BC ICMS ≠ soma itens | Total “fechado” na mão / rateio |
| **532–564** (família totais) | Totais ICMS/ST/PIS/COFINS/produtos | Idem — ver MOC Wxx |
| **564** | Total produtos | `indTot` / itens excluídos |
| **1115** | Grupo IBSCBS não informado | NT 2025.002 / UB12-10 |

Lista **completa** de códigos: MOC 7.0 tabela de rejeições + anexos da NT 2025.002 — **não reproduzir inventando**.

### 7.3 Fontes — seção 7

- MOC 7.0 Anexo I (CONFAZ)  
- Consulta 14/10/2026

---

## 8. Calculadora oficial RTC (Receita / SERPRO)

### 8.1 O que é

Motor oficial de CBS/IBS/IS alinhado à LC 214 e NTs. Mesmo motor no **simulador web** e no **módulo offline**.

### 8.2 API — fato importante (FAQ oficial)

> **Não há API pública de cálculo online para ERP** (FAQ Calculadora v1.4, RFB): integração = **módulo offline** local + API REST interna.

| Endpoint (offline típico) | Uso |
|---------------------------|-----|
| `POST /api/calculadora/regime-geral` | Cálculo regime geral |
| `POST /api/calculadora/gerar-xml` | Geração auxiliar |
| `POST /api/calculadora/validar-xml` | Validar XML |
| Bases IS / CBS-IBS mercadorias | `/api/calculadora/base-calculo/...` |
| Simples Nacional | Endpoint dedicado no Swagger — **confirmar path no Swagger atual** (`.../simples-nacional` aparece em docs de mercado) |

Documentação: https://consumo.tributos.gov.br/servico/calcular-tributos-consumo/calculadora/documentacao  
Swagger: https://consumo.tributos.gov.br/servico/calcular-tributos-consumo/api/swagger-ui/index.html  

### 8.3 Banco offline e atualização

- Pacote offline + base de parâmetros/NCM/cClassTrib.  
- Periodicidade: **NÃO CONFIRMADO** um SLA único público (“toda segunda”); acompanhar releases no portal + changelog do pacote.  
- Integração no fluxo: calcular **antes** de montar grupo UB → gravar CST/cClassTrib/valores → assinar XML → autorizar.

### 8.4 Seu sistema hoje

Motor `FiscalReforma*` no margin-engine com paridade de design à RTC; **sem** cliente HTTP à calculadora. Recomendação de conformidade: dual-run offline RTC nos testes MFCS (já há trilha `0031-reforma-cbs-ibs`).

### 8.5 Fontes — seção 8

- FAQ Calculadora v1.4 (gov.br/receitafederal)  
- Manual Plataforma CBS / serviços RTC (jan–mai/2026)  
- Consulta 14/10/2026

---

## 9. Plano de testes (matriz)

### 9.1 Eixos

`CRT ∈ {1,2,3}` × `op ∈ {interna venda, interestadual B2C, interestadual B2B, devolução, bonificação, remessa, transferência}` × `UF dest` × `trib ∈ {tributado, redução BC, isento, ST subst, ST retido, DIFAL+FCP, FEM, IBS/CBS}`  

### 9.2 Casos mínimos (entrada → saída esperada)

| ID | Entrada | Saída esperada (checagens) |
|----|---------|----------------------------|
| T01 | CRT3, MG→MG, CST00, 1 un × 10,00 | vProd=10,00; vICMS=1,80; totais ok |
| T02 | CRT3, qCom=0,333 × vUn=3,00 | vProd=1,00 (±0,01); sem 629 |
| T03 | CRT3, MG→SP B2C, 1000, alíq 12/18 | DIFAL=60; tags UF dest |
| T04 | CRT3, CST20 redução 30% + DIFAL | **PENDENTE DE CONFIRMAÇÃO COM XML REAL** — não assertar 42,00 nem 69,66 até UF mapping |
| T05 | CRT3, ST MVA 40% + frete 50 + IPI 100 | próprio **126,00**; BC_ST **1610**; vICMSST **163,80** |
| T06 | CRT3, CST60 | sem vICMSST novo; retidos preenchidos |
| T07 | CRT1, CSOSN 102 | sem CST 00; PIS/COFINS SN |
| T08 | CRT1, CSOSN 500 | ST retido |
| T09 | Frete/seguro/desconto na base | Bases ICMS/ST/PIS conforme regra do regime |
| T10 | Devolução finNFe=4 | RefNFe; IBS/CBS conforme NT devolução |
| T11 | Bonificação / remessa | CFOP + CST/CSOSN sem “venda disfarçada” |
| T12 | FEM MG (produto lista) | FCP 2% destacado |
| T13 | Virada 31/12→01/01 | Alíquotas/vigência por **data de emissão** |
| T14 | IBS/CBS 2026 | CST+cClassTrib; 0,9%+0,1% se aplicável ao CRT; dual-run RTC |

### 9.3 Segundo motor independente

1. Calculadora RTC offline (IBS/CBS/IS).  
2. Planilha ou lib separada só para ICMS/ST/DIFAL (não compartilhar código com produção).  
3. Diff campo a campo: tolerância **R$ 0,01** por imposto; divergência > 0,01 = falha.

---

## 10. Segurança e conformidade operacional

| Tema | Requisito mínimo |
|------|------------------|
| Guarda XML | Manter XML autorizado + proc + eventos pelo prazo legal (prática: **5 anos** contábil/fiscal — confirmar com contador para o caso) |
| Cancelamento | Prazo SEFAZ (horas) + justificativa; após prazo: inutilização não substitui cancelamento de autorizado |
| CC-e | Correção de campos permitidos; **não** altera valor/destinatário críticos |
| Inutilização | Numeração não usada |
| Contingência | SVC-AN/RS, EPEC, offline NFC-e — respeitar `tpEmis` e prazos de transmissão |
| Certificado | A1: arquivo+senha com rotação; A3: sessão; monitorar vencimento |
| Auditoria | Log por chave: usuário, payload INI, cStat, tentativa, hash XML |
| Tabelas fiscais | Versionar MVA/NCM/CEST/cClassTrib com **vigência_de/até** |
| Monitoramento | Portal NF-e + SEF/MG DOE + gov.br RTC + CONFAZ — checklist mensal |

---

## 11. As 20 armadilhas mais comuns (software houses)

| # | Armadilha | Como detectar no seu sistema |
|---|-----------|------------------------------|
| 1 | CSOSN em CRT3 ou CST em CRT1 | Assert no builder por CRT |
| 2 | DIFAL com base dupla em B2C | Teste T03 vs Conv. 236 |
| 3 | Ignorar FCP/FEM na alíq. interna dest | Comparar vFCPUFDest |
| 4 | MVA original em operação interestadual | Diff MVA_aj |
| 5 | IPI fora da BC_ST | Fixture §5.3 |
| 6 | CST60 recalculando ST | XML com vICMSST > 0 indevido |
| 7 | ST interestadual sem protocolo | Matriz produto×UF |
| 8 | vProd arredondado antes da conta | Suite 629 |
| 9 | Totais ≠ soma (rateio de desconto) | Pré-validação Wxx |
| 10 | CFOP incompatível com CST/CSOSN | Tabela cruzada |
| 11 | indIEDest errado (1/2/9) | Cadastro destinatário |
| 12 | Benefício MG aplicado em venda a outra UF | Regra de UF da legislação |
| 13 | cClassTrib desatualizado | Versão IT 2025.002 no deploy |
| 14 | Destacar IBS/CBS teste em CRT que NT exclui | Dual check NT×CRT |
| 15 | SN híbrido sem flag de crédito/trava art. 41 §5º | Cadastro + bloqueio |
| 16 | PIS/COFINS não cumulativo em Presumido | Regime tenant |
| 17 | Contingência eterna / tpEmis esquecido | Monitor fila |
| 18 | CC-e alterando valor | Rejeição evento |
| 19 | Tabela MVA sem vigência | Venda com MVA de decreto antigo |
| 20 | Confiar só em “autorizou” | Autorização ≠ tributação correta (autuação) |

---

## 12. Checklist final de auditoria (ordem de risco)

Critério: **PASSOU** só com evidência (XML + tela/log). **NÃO PASSOU** = qualquer divergência > R$ 0,01 ou regra NT violada.

| Ordem | Item | Passou? |
|------:|------|---------|
| 1 | Pré-flight: vProd/qCom/totais (sem 629/531) | |
| 2 | CRT × CST/CSOSN coerentes | |
| 3 | Grupo UB: CST IBS/CBS + cClassTrib da tabela vigente | |
| 4 | Dual-run RTC offline = motor próprio (±0,01) | |
| 5 | DIFAL B2C base única + FCP destino | |
| 6 | ST: MVA ajustada + IPI + FCP-ST | |
| 7 | CST60/500 sem ST novo | |
| 8 | FEM/FECOP MG na lista correta | |
| 9 | Redução BC (CST20) + benefícios Anexo II | |
| 10 | PIS/COFINS conforme regime (até extinção) | |
| 11 | Devolução / complementar / refNFe | |
| 12 | Eventos, contingência, certificado, guarda XML | |
| 13 | Versionamento vigência MVA/NCM/cClassTrib | |
| 14 | SN: opção híbrida e efeitos de crédito documentados | |
| 15 | Monitoramento mensal Portal/SEF/RFB | |

---

## O que preciso confirmar com meu contador ou com a SEFAZ

1. ~~UB12-10 em produção~~ — **fechado no PDF v1.52:** “implementação futura para produção”; homologação CRT 3 desde 01/07/2026; cStat **1115** associada.  
2. Se **CRT 1 e 2** devem destacar IBS/CBS em 2026 mesmo sem alíquota teste / recolhimento (obrigação legal ≠ rejeição).  
3. ~~Prazo SN híbrido 30/09 vs 30/10~~ — **fechado:** PDF CGSN 07/10/2026 confirma **30/10/2026** (0× “30/09” no PDF).  
3b. **FEM MG na MVA ajustada** — a Orientação 2016 **não** vale como prova do FEM 2024+; pedir posicionamento SEFAZ-MG/contador.  

4. **Alíquotas internas e FEM** por NCM da carteira real (não usar só “18%”).  
5. Produtos da carteira no **Anexo VII** (ST) e protocolos interestaduais ativos.  
6. Política MG de **recolhimento DIFAL** (por operação vs inscrito / prazo).  
7. Tratamento de **pauta/PMPF** nos NCMs que o ERP vende.  
8. Alíquota de referência CBS **2027+** quando o Senado publicar (hoje não inventar %).  
9. Prazo de **guarda** documental específico do cliente (matriz × fiscal).  
10. Se a empresa fará **opção pelo regime regular de IBS/CBS** (impacto de preço B2B e crédito do cliente).  
11. Lista de rejeições **11xx** da NT 2025.002 realmente ativas no autorizador da UF.  
12. Qualquer **benefício fiscal** (crédito outorgado, REPOM, etc.) não coberto pelo Anexo II genérico.  
13. **DIFAL + CST 20:** para cada UF de destino da carteira, se a SEFAZ exige DIFAL **42,00** (por fora sobre BC reduzida) ou **69,66** (base reduzida por dentro) — enviar XML autorizado.  
14. **FECOP/FEM na MVA ajustada:** em quais UFs de destino o fundo entra no denominador da MVA (hoje o motor **não** inclui).  
15. Lista de **UFs × NCM com CST 20** efetivamente usadas na carteira (o agente **não** consultou o banco de produção).

---

## Contexto do seu stack (para amarrar testes)

| Camada | Papel |
|--------|--------|
| `margin-engine` … `FiscalReforma*`, `FiscalIcms*`, `AcbrIniSections` | Cálculo + INI |
| `agente-local` ACBrLib | Transmissão / eventos |
| Certificação | `margin-fiscal/certification` + caso reforma CBS/IBS |

**Regimes:** CRT 1 (Simples), CRT 2 (excesso sublimite), CRT 3 (Presumido **e** Real). PIS/COFINS **não** decide só pelo CRT: o cadastro guarda `regime_tributario` (`LUCRO_PRESUMIDO` 0,65%/3% cumulativo vs `LUCRO_REAL` 1,65%/7,60% não cumulativo) via `TenantRegimeTributario` + `FiscalPisCofinsPorRegime`.

Próximo passo técnico sugerido: fechar os itens 1–4 do checklist 12 com XML reais de homologação pós **26/10/2026**.

---

## Correções feitas em 14/10/2026

Sem bump de versão (pedido explícito). Escopo só dos itens 1–4 da auditoria.

| # | Tema | O que foi feito |
|---|------|-----------------|
| 1 | ICMS-ST + frete | Doc §5.3 e T05: próprio **126,00** / ST **163,80**. Motor: `FiscalMoneyMath.baseIcmsProprio` / `baseOperacaoSt` / `icmsStComFreteEIpi`; `EntradaObrigacaoGatilho.baseCalculoSt` + `baseIcmsProprioParaSt`; `IcmsStProtocoloCalculator` recalcula próprio sem IPI; `IcmsStProtocoloService` passa bases compostas. Teste `FiscalMoneyMathIcmsStFreteTest`. |
| 2 | DIFAL CST 20 | Doc §4.4 e T04: **PENDENTE DE CONFIRMAÇÃO COM XML REAL** (42,00 ≠ 69,66). Motor: modos `BASE_UNICA` e `BASE_REDUZIDA_POR_DENTRO`; catálogo com UFs CST20 **vazio** + override; teste `DifalBaseReduzidaCst20Test`. |
| 3 | FECOP na MVA | Doc §5.2: default sem fundo; parâmetro `incluirFundoNoDenominador` + `MvaAjustePoliticaCatalog`. Teste `MvaAjusteFundoPoliticaTest`. |
| 4 | PIS/COFINS | Confirmado: já distingue Presumido×Real por `regime_tributario` (não só CRT 3). Testes existentes `FiscalPisCofinsPresumidoVsRealTest` mantidos. |

**NÃO CONFIRMADO (ainda):** FEM MG no denominador da MVA (pós-2024); DIFAL CST 20 por UF (42 vs 69,66); datas ENCAT 26/10 e 16/11 (fora do PDF NT); ativação de catálogos sem XML.

**Atualizado com fonte oficial nesta sessão (releitura):**
- Janela SN híbrido **01/09/2026–30/10/2026** — PDF Manual CGSN **Versão de 07/10/2026** (reaberto; 0× “30/09”).
- LC 227/2026 (Planalto) — CGIBS / processo IBS; sem leiaute NF-e.
- CE FECOP na MVA — IN 43/2017 (+149/2023); modo desligado até XML.
- MG FEM na MVA — **NÃO CONFIRMADO** (não usar Orientação 2016 como prova do FEM 2024+).
- NT **2025.002 v1.52** + IT **v1.70** baixados do SVRS — UB12-10 produção = implementação futura; **1115** no PDF.
- Dual-run RTC offline SERPRO — **12/12 OK** (± R$ 0,01).

---

## Fechamento — pesquisa Parte A (14/10/2026)

### A1 — DIFAL + CST 20 (base “por dentro” vs BC reduzida)

Caso didático: operação 700; inter 12%; interna 18%; redução 41,176% (BC = 411,76) → **42,00** (sobre BC reduzida) vs **69,66** (recomposição por dentro).

| UF / tema | Regra | Fonte (link) | Data consulta | Nível |
|-----------|-------|--------------|---------------|-------|
| Nacional B2C | Base **única** = valor da operação (cl. 2ª §1º); FCP na alíq. interna (§4º); reduções/isenções no DIFAL nos termos do Conv. 153/2015 (§5º) | [Conv. ICMS 236/2021](https://www.confaz.fazenda.gov.br/legislacao/convenios/2021/CV236_21) | 14/10/2026 | CONFIRMADO em fonte oficial |
| Nacional B2C + benefício | Redução/isenção de BC **considerada** no DIFAL interestadual a não contribuinte | [Conv. ICMS 153/2015](https://www.confaz.fazenda.gov.br/legislacao/convenios/2015/CV153_15) cl. 1ª §1º | 14/10/2026 | CONFIRMADO em fonte oficial |
| Interpretação 42 vs 69,66 (nacional) | Conv. 236/153 aponta DIFAL sobre BC já reduzida (≈ **42,00** ilustrativo) | 236/21 + 153/15 acima | 14/10/2026 | CONFIRMADO em fonte oficial (plano nacional; **não** fecha UF) |
| MG autorizou XML com ≈69,66 | Autorização ≠ tributação correta; também **não** se ignora. Quem decide é a **UF de destino**. Catálogo permanece **vazio** | XML autorizado SEFAZ-MG (referência de mercado do estudo) | 14/10/2026 | NÃO CONFIRMADO como regra (evidência conflitante) |
| UFs da carteira (DB local) | Tenants com UF: **somente MG**; **0** CST 20 nos XMLs PDV 12m → risco operacional baixo hoje | Consulta agregada (sem PII) | 14/10/2026 | CONFIRMADO (dado local) |
| Esforço de produto | **Não** investir em popular `UFS_BASE_REDUZIDA_CST20` até CST 20 aparecer na carteira + XML/norma UF | — | 14/10/2026 | Decisão de escopo |

### A2 — FECOP/FEM no denominador da MVA ajustada

| UF / tema | Regra | Fonte (link) | Data consulta | Nível |
|-----------|-------|--------------|---------------|-------|
| Nacional ST | Conv. 142/2018 fixa bases ST (MVA da UF destino / protocolo); **não** impõe FECOP no denominador da MVA ajustada como regra geral | [Conv. ICMS 142/2018](https://www.confaz.fazenda.gov.br/legislacao/convenios/2018/CV142_18) | 14/10/2026 | CONFIRMADO em fonte oficial (silêncio ≠ obrigação) |
| CE | Quando devido FECOP, `ALQ intra` = carga tributária total (alíquota + FECOP) na MVA ajustada | [IN SEFAZ-CE 43/2017](https://sefazlegis.sefaz.ce.gov.br/api/openFile?id=641fab30-da4d-4f6c-a968-0263a9e4013e) / IN 149/2023 | 14/10/2026 | CONFIRMADO em fonte oficial — **modo desligado** até XML autorizado (B2) |
| MG FEM 2% (lista / existência) | Adicional 2 p.p. FEM — Lei 24.471/2023 (efeitos **01/01/2024**) | [Lei 24.471/2023 SEF/MG](https://www.fazenda.mg.gov.br/empresas/legislacao_tributaria/leis/2023/l24471_2023.html) | 14/10/2026 | CONFIRMADO em fonte oficial (existência do adicional) |
| MG FEM **no denominador da MVA** | Sem norma pós-2024 encontrada nesta sessão que diga se o FEM entra em `ALQ intra` da MVA ajustada. A Orientação DOLT/SUTRI **003/2016** é anterior ao FEM atual → **não usar** como prova. Default motor = não incluir (conservador). | Perguntar SEFAZ-MG / contador | 14/10/2026 | **NÃO CONFIRMADO** |

### A3 — Itens que estavam NÃO CONFIRMADO

| Tema | Regra / status | Fonte (link) | Data consulta | Nível |
|------|----------------|--------------|---------------|-------|
| NT 2025.002 vigência | **v1.52** (Setembro/2026), 94 pág. — baixada do SVRS | [SVRS DownloadArquivoEstatico NT v1.52](https://dfe-portal.svrs.rs.gov.br/NFE/DownloadArquivoEstatico/?sistema=NFE&tipoArquivo=3&nomeArquivo=NT_2025.002_v1.52_RTC_NF-e_IBS_CBS_IS.pdf) | 14/10/2026 | CONFIRMADO em fonte oficial |
| IT 2025.002 tabelas | **v1.70** — abas `cClass 2026-09-01` / `CST 2026-09-01` (xlsx) | SVRS `IT 2025.002 v.1.70 - cClassTrib.xlsx` | 14/10/2026 | CONFIRMADO em fonte oficial |
| UB12-10 produção | PDF p.40: Obs. 2 produção CRT3 a partir 03/08/2026 **riscada/substituída** por “**implementação futura para produção**”; homologação CRT3 desde 01/07/2026 mantida | NT 2025.002 v1.52 p.5 e p.40 | 14/10/2026 | CONFIRMADO em fonte oficial |
| Rejeição 1115 | “Grupo IBSCBS não informado” ligada à UB12-10; em produção a RV ainda é futura | NT 2025.002 v1.52 p.40 | 14/10/2026 | CONFIRMADO em fonte oficial |
| Rejeições 11xx | Dezenas de códigos 1100–1199 no PDF (IBS/CBS/IS/devolução etc.) — ativas conforme cronograma de cada RV (várias “implementação futura”) | NT 2025.002 v1.52 | 14/10/2026 | CONFIRMADO em fonte oficial (lista no PDF; vigência RV a RV) |
| Datas 26/10 e 16/11/2026 | **Não** constam no PDF v1.52 (v1.52 cita 05/10 e 03/11 para VC02-*). Adiamento ENCAT/Portal → **NÃO CONFIRMADO** sem o aviso oficial em mãos | — | 14/10/2026 | NÃO CONFIRMADO |
| LC 227/2026 × NF-e | Institui CGIBS / processo IBS / altera LC 214; **não** define leiaute/cStat NF-e | [Planalto LC 227](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp227.htm) | 14/10/2026 | CONFIRMADO em fonte oficial |
| SN híbrido janela | **01/09/2026 a 30/10/2026** (1º sem./2027); PDF **Versão de 07/10/2026**; **0** ocorrência de 30/09 no PDF | [PDF Manual CGSN](https://www8.receita.fazenda.gov.br/SimplesNacional/Arquivos/manual/Manual%20op%C3%A7%C3%A3o%20regime%20regular%20IBS%20e%20CBS%20no%20Simples%20Nacional.pdf) | 14/10/2026 | CONFIRMADO em fonte oficial |

---

## Fechamento — pendências

| # | Pendência | Por quê |
|---|-----------|---------|
| 1 | Popular `UFS_BASE_REDUZIDA_CST20` | Evidência conflitante (Conv. 236 ≈42 vs XML MG ≈69,66). **0** CST 20 na carteira local — **adiar** até aparecer na carteira + XML/norma UF |
| 2 | Ativar CE em `MvaAjustePoliticaCatalog` | Fonte CE ok; falta **XML autorizado** CE com FECOP na MVA |
| 3 | MG FEM no denominador da MVA | **NÃO CONFIRMADO** (Lei 24.471/2023 ≠ Orientação 2016). Perguntar SEFAZ-MG/contador |
| 4 | Dual-run IBS/CBS × RTC | **Fechado nesta sessão:** 12/12 OK (±0,01) vs JAR SERPRO offline `api-regime-geral` 1.5.4 (cClassTrib 000001, fato 2026) |
| 5 | Testes dourados checklist (B7) | 7 casos em **todo/pending** no CI até XML autorizado |
| 6 | ST emissão `BLOQUEAR` | Manter **AVISAR** 2–4 semanas; só BLOQUEAR depois e **só MVA** (pauta/PMPF ignorados) |
| 7 | Datas ENCAT 26/10 e 16/11 | Não estão no PDF NT v1.52 — confirmar aviso oficial se forem usadas no go-live |

**Pré-publicação acbr.js (CRT 3):** DB local (14/10/2026) — **0** tenants CRT 3 vigentes; 10/10 = CRT 1 / `SIMPLES`. Histórico: 1 período CRT 3 + `LUCRO_PRESUMIDO` já encerrado (`vigente_ate` 09/10/2026). SQL: `scripts/sql/auditoria-crt3-sem-regime-pis.sql` (rodar em produção antes do deploy).

**XMLs necessários (anonimizados, autorizados cStat 100/150):** só quando for fechar B2/B7 — DIFAL CST 20 por UF; FECOP CE; frete/ST/IPI; CST 60/500; devolução; FEM MG se existir.

---

*Documento gerado para estudo interno. Não substitui parecer jurídico/contábil. Consulta às fontes: 14/10/2026.*
