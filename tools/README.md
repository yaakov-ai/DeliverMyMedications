# Per-strength pricing

Every medication in the site lists its standard FDA-labeled strengths (from DailyMed labeling). Each strength starts at that product's TelyRx starting price. To set your own price for any strength:

1. Open `DeliverMyMedications-Price-List.xlsx` and go to the **Price Grid** tab.
2. Type a price in **Your price** (yellow column) for any row. Leave it blank to keep the starting price.
3. To sell a larger size, copy a row, change **Quantity** (for example "90 tablets"), and set its price. Don't change **Product ID**.
4. Save the workbook, then run:

```
pip install openpyxl
python apply_price_grid.py ../DeliverMyMedications-Price-List.xlsx ../DeliverMyMedications-App.html
```

On the product page, the strength and quantity buttons then show your prices. A strength/quantity combination with no row is shown as "not offered."

The compounded semaglutide and tirzepatide sliders always use one flat price, set on the Price List tab.

## Optional: pull TelyRx's own per-strength prices
`telyrx_price_grid.py` crawls TelyRx product pages; run it on your computer, and check their terms of use first. Then run `python apply_price_grid.py telyrx_price_grid.csv ../DeliverMyMedications-App.html ../DeliverMyMedications-Price-List.xlsx`. GLP-1s are set at TelyRx minus $1.
