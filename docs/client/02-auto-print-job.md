AUTO PRINT JOB → CRM ENTRY

જ્યારે Radhe Digital Sign Boardના કોઈ Computerમાંથી કોઈ File Printing માટે મોકલવામાં આવે ત્યારે CRMમાં Automatic Print Job Entry થવી જોઈએ.

FLOW

Computer File
↓
Print Command
↓
Small CRM Popup
↓
Customer Select
↓
Job Details
↓
Print
↓
CRMમાં Automatic Entry

PRINT POPUPમાં

Print કરતાં પહેલાં નાનું Popup આવે:

- Customer Name
- Mobile Number
- Existing Job No. / New Job
- File Name — Automatic
- Machine Select
- Printing Type
- Width
- Height
- Quantity
- Sq. Ft. — Automatic Calculation
- Rate
- Total Amount — Automatic
- Paid / Unpaid / Credit
- Advance Received
- Balance
- Operator Name — Automatic
- Date & Time — Automatic

પછી PRINT Button દબાવતા actual printing શરૂ થાય.

---

CRMમાં AUTOMATIC ENTRY

Example:

Customer: ABC Enterprise
File: ABC_FRONT_BOARD.cdr
Machine: UV Roll to Roll
Size: 6 × 3 Ft
Qty: 2
Total Sq.Ft.: 36
Rate: ₹25
Amount: ₹900

Payment Status:

🔴 PAYMENT PENDING – ₹900

અથવા

🟢 PAYMENT RECEIVED – ₹900

---

EXISTING CUSTOMER JOB

જો આ printing પહેલેથી ચાલતા Order/Job માટે હોય તો:

Attach to Existing Job

Option આપવું.

Example:

Job No: RDS-2026-125

એ jobમાં તમામ printing cost / quantity automatically add થાય.

---

PAYMENT STATUS

CRMમાં Print Jobs માટે અલગ status:

🔴 Unpaid
🟡 Part Payment
🟢 Paid
🔵 Credit Customer

Payment receive થાય એટલે Print Jobમાં પણ status automatically update થવો જોઈએ.

Invoice Payment અને Print Job Payment એકબીજા સાથે linked હોવા જોઈએ.

---

PRINT HISTORY

Customer open કરીએ ત્યારે:

Print Date | File | Machine | Size | Qty | Amount | Payment

બધી History જોવા મળવી જોઈએ.

---

FILE LINK

Original Fileનું location CRMમાં store કરવું:

Example:

D:\RADHE JOBS\ABC\ABC_FRONT_BOARD.cdr

CRMમાંથી Open File button આપવો.

જો possible હોય તો Preview/Thumbnail પણ બતાવવું.

---

REPRINT

એક જ file ફરી Print થાય તો system પૂછે:

New Print Job
અથવા
Reprint Existing Job

Reprint quantity અને cost અલગથી record થવી જોઈએ.

---

OWNER ALERT

Dashboard:

Today's Print Jobs: 42
Print Value: ₹28,450
Received: ₹19,000
Pending: ₹9,450

અને ખાસ Report:

Printed But Payment Pending

આ reportથી જે કામ print થઈ ગયું છે પણ payment બાકી છે એ તરત દેખાવું જોઈએ.

---

IMPORTANT

Print થયા વગર માત્ર File Open કરવાથી CRM Entry ન થવી જોઈએ.

Actual Print Command / Print Confirmation પછી જ Print Job create થવો જોઈએ.

અને Print Job Delete/Edit થાય તો Audit History રહેવી જોઈએ.
