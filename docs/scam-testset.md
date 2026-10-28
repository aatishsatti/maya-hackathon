# Maya scam-shield test set

Maya scam-shield test set. Every example was written by the Maya team for this test; none comes from a real person or a real message. Phone numbers are fictional (555-01xx). tranche: 1 = the first, classic set; 2 = the harder set (subtle scams with no scary words, genuine messages that look urgent), written blind before any detector output was seen. label: scam | normal. channel: text = a message as it arrives; spoken = the person telling Maya, in their own words, what happened. hard: a scam with no scary words, or a genuine message that looks urgent. now: a scam in progress (the person is about to pay or act). legitpay: a genuine payment in progress. split: dev (used to build and tune) | held (kept for the final, untouched number).

152 items in two tranches: 76 scams, 76 normal. Dev = used to build and tune. Held-out = never used for tuning; reported once at the end.

## SCAM

| id | split | kind | channel | notes | text |
|---|---|---|---|---|---|
| S001 | dev | bank | text |  | URGENT: Your account has been temporarily locked due to suspicious activity. Verify your details within 24 hours at secure-bank-verify.example or your account will be closed. |
| S002 | held | bank | text |  | Hi, this is the fraud team at your bank. We have blocked a payment of $1,840. To cancel it please reply with the 6-digit code we just sent you. |
| S003 | dev | bank | text | hard | Dear customer, we are updating our security system. Please confirm your online banking login so we can keep your account running smoothly. Thank you for banking with us. |
| S004 | held | bank | spoken |  | A lady rang me saying she was from my bank and that someone had tried to take my money. She wanted me to read out the number that came in a text so she could stop it. |
| S005 | dev | bank | spoken |  | Someone phoned saying my card had been cloned. He told me to move my savings into a safe account he would give me and not to tell the bank staff because one of them is in on it. |
| S006 | held | government | text |  | FINAL NOTICE: You owe $2,300 in unpaid taxes. A warrant will be issued for your arrest unless you pay today with gift cards. Call 555-0143 immediately. |
| S007 | dev | government | text |  | Your government benefit payment is on hold. Confirm your national insurance number and bank details here to release it: gov-benefit-claims.example |
| S008 | held | government | text | hard | Our records show you overpaid last year and are due a refund of $412. Please submit your bank details through the link to receive it. |
| S009 | dev | government | spoken |  | A man phoned from the tax office and said I would be arrested this afternoon if I did not pay. He wanted me to pay by buying vouchers. |
| S010 | held | government | spoken |  | I got a call saying my pension was being stopped because of a mistake in my records and that I had to give my bank number to fix it. |
| S011 | dev | prize | text |  | Congratulations! You have been selected to receive a $5,000 shopping reward. To claim, pay the $49 delivery fee at the link below within 12 hours. |
| S012 | held | prize | text |  | You have won the national lottery draw! Contact our claims agent with a copy of your passport and a processing fee of $200 to release your winnings. |
| S013 | dev | prize | text | hard | Thank you for taking our short survey. As a loyal customer you can claim a free kitchen set; just enter your card number to cover shipping of $2.99. |
| S014 | held | prize | spoken |  | I had a message that said I had won a holiday abroad but I have to send them two hundred pounds first for the taxes. |
| S015 | dev | prize | spoken |  | A woman phoned to say I won a car in a competition I do not remember entering. She wants my bank details to deliver the prize. |
| S016 | held | grandchild | text |  | Grandma it is me, I lost my phone and I am in trouble. I had an accident and need $900 for the lawyer. Please do not tell mom and dad. Send it by gift card. |
| S017 | dev | grandchild | text |  | Hi Grandpa this is my new number. I am stuck abroad and my wallet was stolen. Can you wire money today? I will explain later, please keep it between us. |
| S018 | held | grandchild | text | hard | Hey nan, new number, my old phone broke. Are you free? I need a favour, something a bit embarrassing. Can you buy some gift cards for me, I will pay you back at the weekend. |
| S019 | dev | grandchild | spoken |  | A young man rang crying and said Gran it is me, he had been in a car accident and needed bail money and said not to tell my son. |
| S020 | held | grandchild | spoken |  | My grandson texted from a new number asking me to buy some vouchers and send him the codes because he is locked out of his account. |
| S021 | dev | techsupport | text |  | WARNING: Your computer has been infected with 5 viruses! Call Microsoft Support at 555-0177 immediately to prevent data loss. Do not shut down your computer. |
| S022 | held | techsupport | text |  | Your Windows license has expired. Call our certified technician now; remote access is required to restore your files. |
| S023 | dev | techsupport | text | hard | Hello, this is a courtesy call from your internet provider. We noticed slow speeds on your line. If you open the app we send, our engineer can fix it for you for free in a few minutes. |
| S024 | held | techsupport | spoken |  | A pop-up came up on my computer with a loud noise saying I had a virus and to ring a number. The man told me to install a program so he could see my screen. |
| S025 | dev | techsupport | spoken |  | A man called from my internet company and asked me to let him control my computer so he could give me a refund, and then he said he had put in too much and I had to send the extra back. |
| S026 | held | parcel | text |  | Your parcel could not be delivered due to an unpaid customs fee of $3.45. Pay now at post-delivery-fee.example to reschedule or it will be returned. |
| S027 | dev | parcel | text |  | Delivery attempt failed. Confirm your address and pay a small redelivery charge via the link to receive your package today. |
| S028 | held | parcel | text | hard | Hi, we have a package for you but nobody was home. Please reply with your full name and card details to arrange re-delivery on Thursday. |
| S029 | dev | parcel | spoken |  | I got a text about a parcel that I needed to pay a few pounds for to get it delivered, but I have not ordered anything. |
| S030 | held | parcel | spoken |  | There was a card through the door and then a text saying pay the customs on my parcel online with my card. |
| S031 | dev | utility | text |  | Your electricity will be disconnected today at 5pm due to an overdue balance of $286. Pay immediately by bank transfer to avoid disconnection. Call 555-0190. |
| S032 | held | utility | text |  | FINAL WARNING: your gas account is in arrears. A technician will cut your supply within 2 hours unless you pay using a prepaid card. |
| S033 | dev | utility | text | hard | We have been trying to reach you about your energy account. A smart meter upgrade is due and you may be eligible for a credit. Please confirm your account number and date of birth. |
| S034 | held | utility | spoken |  | A man phoned saying he is from the electric company and that they would turn off my power in an hour unless I paid straight away over the phone with my card. |
| S035 | dev | utility | spoken |  | Somebody knocked and said he was from the water company and needed to check my pipes, and then he said I owed a bill and wanted it in cash. |
| S036 | held | insurance | text |  | Your Medicare card is expiring. To receive your new card, reply with your Medicare number and bank details. Failure to respond may suspend your benefits. |
| S037 | dev | insurance | text |  | Final reminder: your car insurance policy was cancelled. Renew today for $99 by sending payment details to this number or you risk a fine. |
| S038 | held | insurance | text | hard | You are eligible for a free medical alert device and a back brace covered by your plan. Confirm your insurance number and we will ship them at no cost. |
| S039 | dev | insurance | spoken |  | A woman rang about a new Medicare card and asked for my number and date of birth so she could send it. |
| S040 | held | insurance | spoken |  | Someone phoned to say I am owed a refund on my insurance and they needed my account number to put it in. |
| S041 | dev | romance_invest | text |  | My dear, I am an engineer working on an oil rig overseas. I have fallen in love with you. I need $1,500 to complete my contract and fly home to meet you. Please help me. |
| S042 | held | romance_invest | text |  | Exclusive: our crypto trading platform guarantees 30% monthly returns. Deposit $1,000 today; limited spots; no risk. |
| S043 | dev | romance_invest | text | hard | I know we only met online three weeks ago but I trust you. A friend there is holding a package for me; could you pay the customs fee for me? I will repay you when we meet. |
| S044 | held | romance_invest | spoken |  | A man I have been chatting to online says he is in hospital abroad and needs me to send money to the clinic, and says I must not tell my daughter. |
| S045 | dev | romance_invest | spoken |  | A friendly man on the phone told me about an investment that cannot lose and says I should move my pension money in this week. |
| S046 | held | charity | text |  | Your donation can save a child today! Please donate $100 via gift card to our emergency fund; reply with the card code. |
| S047 | dev | charity | text |  | Thank you for supporting disaster relief. Your contribution of $500 is overdue, please confirm payment details to avoid legal action. |
| S048 | held | charity | text | hard | We are collecting for the local children's hospital and the number of donors is limited this month. Would you give your card details now so you can give today? |
| S049 | dev | charity | spoken |  | A man phoned asking for money for a children's charity and would not take no, he said if I did not give my card number now the children would suffer. |
| S050 | held | charity | spoken |  | A lady called about a veterans fund and wanted a gift card code over the phone. |
| S051 | dev | in_progress | spoken | now | A man on the phone told me my grandson is in jail and I need to buy gift cards for bail. I am on my way to the shop right now to get them. |
| S052 | held | in_progress | spoken | now | The lady from the bank said to transfer all my savings to the safe account. I have the details here and I am about to do it on the computer. |
| S053 | dev | in_progress | spoken | now | He is still on the phone and he is asking me to read out the code that just came in a text. I have got it in front of me now. |
| S054 | held | in_progress | spoken | now | The taxman says I must pay today or be arrested, so I am going to the post office to send the money by courier. |
| S055 | dev | in_progress | spoken | now | They told me to install the program so they can fix my computer. I have just downloaded it and he wants me to click run. |
| S056 | held | in_progress | spoken | now | My online friend needs the money for the hospital. I am about to send the two thousand through the money transfer place. |
| S113 | dev | subtle_bank | text | hard | Hello, thanks for being a valued customer. We have a new savings rate for you. To move your current balance and get the better rate, please verify your online banking by replying with the code we have just texted. |
| S114 | held | invoice_fraud | text | hard | Hi, please find attached the invoice for the boiler service last month. Our bank details have changed, so kindly send the payment of $320 to the new account below. |
| S115 | dev | solicitor_fraud | text | hard | Dear Mrs Brown, your solicitor's office here. The house sale completes Friday. For security please transfer the funds to our client account, details attached. Please contact us only on this number as our main line is down. |
| S116 | held | refund_callback | text | hard | Your antivirus subscription renewed for $349 today. If you did not authorise this, call 555-0162 to arrange a refund. |
| S117 | dev | fake_job | text | hard | We saw your profile and have a part-time job: process payments for our clients from home, $200 per day. We will send you a cheque to cover equipment; deposit it and forward the balance to our supplier. |
| S118 | held | friend_in_need | text | hard | Hi, it is Paul from the golf club. I am in a bit of a bind, my card got declined at the airport. Could you send $300 by transfer, I will refund you as soon as I am back Thursday? My phone is nearly dead so text only please. |
| S119 | dev | rebate | text | hard | You are owed a $146 energy rebate under the new government scheme. Check your eligibility and claim in two minutes at energy-rebate-claim.example. No documents needed except your card for identity. |
| S120 | held | court_notice | text | hard | Re: jury service. Our records show you did not attend. To avoid a fine please confirm your details at the court portal link. Reference JS-4471. |
| S121 | dev | bank_security_test | spoken | hard | A very polite young man from my bank's security department said the account was fine but they were testing a new system and he needed me to confirm my card number and the three digits on the back for the test. |
| S122 | held | council_rebate | spoken | hard | A woman from the council phoned to say I am entitled to a rebate and could she just confirm my bank account so they can pay it in. She was very nice. |
| S123 | dev | doorstep | spoken | hard | A man at the door said he was doing roof repairs for the neighbour and noticed some loose tiles on mine. He offered to do it today cheaply for cash and asked for half up front. |
| S124 | held | health_check | spoken | hard | I got a lovely call from a lady who said I had been chosen for a free health check at home, she only needed my Medicare details and bank account to book it. |
| S125 | dev | dating | spoken | hard | A man I met on a dating site two months ago wants to meet me but says his bank account is frozen while he is abroad and asked if I could cover his flight ticket. He is very sweet. |
| S126 | held | investment_app | spoken | hard | My neighbour's son recommended an app where you can double your savings in a month. He showed me his account on his phone and it did look like he had made a lot. I have been asked to put in five thousand to start. |
| S127 | dev | storage_popup | spoken | hard | A message on my tablet said my photos would be deleted unless I paid for extra storage, and it gave a number to ring to sort it out. |
| S128 | held | charity_police | spoken | hard | A woman phoned from the police benevolent fund. She was ever so polite and said they just need a small donation, could I read out my card number there and then. |
| S129 | dev | in_progress | spoken | now | He said to stay on the line and not hang up while I go to the bank to take out the cash. I am walking there now with him still on the phone. |
| S130 | held | in_progress | spoken | now | The man on the phone is helping me with my computer and he has asked me to type in the address he gave me. It is some kind of support page and I am just about to press enter. |
| S131 | dev | in_progress | spoken | now | She told me the prize needs a fee of two hundred and I am at the cash machine now to get it out, I am putting the card in. |
| S132 | held | in_progress | spoken | now | He asked for the numbers off the gift cards. I have scratched them off and I have got them in my hand, I am about to read them to him. |

## NORMAL

| id | split | kind | channel | notes | text |
|---|---|---|---|---|---|
| N057 | held | bill | text |  | Your electricity statement for September is ready. Amount due $84.20 by October 25. View it any time in your online account or by calling the number on your bill. |
| N058 | dev | bill | text |  | Reminder: your mobile bill of $39.00 will be taken by direct debit on 3 November. No action needed. |
| N059 | held | bill | text | hard | Your gas account is overdue by $64.30. Please pay by October 31 to avoid a late fee. You can pay by card on our website or by phone. |
| N060 | dev | bill | spoken |  | I got my phone bill this morning and it is a bit higher than normal, I think because of the calls to my sister. |
| N061 | held | bill | spoken |  | The water company sent a letter saying the meter will be read next week and someone will call round with an ID badge. |
| N062 | dev | appointment | text |  | Reminder: you have an appointment with Dr. Patel on Tuesday at 10:30am. Reply C to confirm or call the clinic to reschedule. |
| N063 | held | appointment | text |  | Your dental check-up is tomorrow at 2pm. Please arrive 10 minutes early. Reply YES to confirm. |
| N064 | dev | appointment | text | hard | URGENT: We have not heard from you. Please confirm your hospital appointment today or it will be given to another patient. Reply YES. |
| N065 | held | appointment | spoken | hard | The hospital phoned to move my eye appointment to Friday, and they asked me to confirm my date of birth, which seemed normal. |
| N066 | dev | appointment | spoken |  | My doctor's surgery sent a text about the flu jab, I can book it online or by ringing the desk. |
| N067 | held | pharmacy | text |  | Your prescription is ready for collection at the pharmacy. Please bring photo ID. Open until 6pm. |
| N068 | dev | pharmacy | text |  | Your repeat prescription will be ready on Thursday. Reply STOP to opt out of reminders. |
| N069 | held | pharmacy | text | hard | Your medication order has shipped. Track it with your order number. We will never ask for your card number or PIN by text. |
| N070 | dev | pharmacy | spoken |  | The chemist rang to say my tablets are in, I can pick them up any time before six. |
| N071 | held | pharmacy | spoken |  | The pharmacy told me the doctor changed my dose and gave me a new leaflet. |
| N072 | dev | family | text |  | Hi Nana! Are you free on Sunday? We will come over for lunch around 12. Love you x |
| N073 | held | family | text |  | Dad, just landed safely. Will call you tonight when I am at the hotel. |
| N074 | dev | family | text | hard | It is me, my number changed because I dropped my phone in the lake. Save this one instead. Call me tonight, I will tell you all about the trip! |
| N075 | held | family | spoken |  | My granddaughter rang from university, she passed her exam and wants to visit at the weekend. |
| N076 | dev | family | spoken |  | My son texted to say he will be late and to start dinner without him. |
| N077 | held | bank_genuine | text |  | Card ending 4821: a payment of $25.40 at Green Grocers was made on 24 Oct. If you do not recognise it, call the number on the back of your card. We will never ask for your PIN or password. |
| N078 | dev | bank_genuine | text |  | Your monthly statement is now available in online banking. Log in as usual from our app. |
| N079 | held | bank_genuine | text | hard | Security alert: a new device signed in to your account. If this was you, no action is needed. If not, please call the number on the back of your card. Never share a one-time code with anyone, including us. |
| N080 | dev | bank_genuine | spoken |  | My bank sent a letter about changes to their opening hours and the branch is moving across the road. |
| N081 | held | bank_genuine | spoken | hard | The bank rang to tell me a payment was flagged and asked me to hang up and call back on the number on my card, which I did and it was a genuine check. |
| N082 | dev | delivery_genuine | text |  | Your order 48213 has been dispatched and will arrive Thursday between 9am and 1pm. Track it in the app. |
| N083 | held | delivery_genuine | text |  | Your parcel was delivered to your front porch at 2:14pm. |
| N084 | dev | delivery_genuine | text | hard | We missed you. Your parcel is at the local collection point; bring photo ID and the card we left. No payment is needed. |
| N085 | held | delivery_genuine | spoken |  | The postman left a card saying he will try again tomorrow and that I can pick it up from the sorting office if I miss him. |
| N086 | dev | delivery_genuine | spoken |  | The delivery man rang the bell with the grocery order I made on Monday and checked my name. |
| N087 | held | newsletter | text |  | This week at the garden centre: 20% off all bulbs and a free talk on autumn pruning on Saturday. See you there! |
| N088 | dev | newsletter | text |  | Your library books are due back on 3 November. You can renew them online or in person. |
| N089 | held | newsletter | text | hard | Hurry, last chance! Our autumn sale ends tonight, save up to 50% on coats and boots. Shop now online or in store. |
| N090 | dev | newsletter | spoken |  | A flyer came through the door for the new bakery with a voucher for a free coffee. |
| N091 | held | newsletter | spoken |  | I got an email from the knitting club about the next meeting and a raffle. |
| N092 | dev | government_genuine | text |  | Your council tax bill for the new year is enclosed. You can pay by direct debit, online, or at the post office. Contact the council if you need help. |
| N093 | held | government_genuine | text |  | Your State Pension forecast is ready to view when you log in to your government account. |
| N094 | dev | government_genuine | text | hard | Reminder: your vehicle registration expires on 30 November. Renew on the official government website using the reference letter we posted to you. |
| N095 | held | government_genuine | spoken |  | The council sent a letter that the bins will be collected on a different day over Christmas. |
| N096 | dev | government_genuine | spoken |  | I had a letter from the pension service saying my payment day is changing, no action needed. |
| N097 | held | friends | text |  | Are you coming to bridge on Thursday? Margaret says she is bringing the lemon cake. |
| N098 | dev | friends | text |  | Thanks for the lovely tea yesterday, the scones were perfect! |
| N099 | held | friends | text | hard | Hi it is Jean from church. We are collecting for the roof fund and I will drop the envelope by on Sunday if you would like to give something. No pressure at all. |
| N100 | dev | friends | spoken |  | My neighbour popped by to ask if I wanted to join the walking group on Wednesday. |
| N101 | held | friends | spoken |  | My friend Alan rang to say his hip operation went well. |
| N102 | dev | subscriptions | text |  | Thank you for your $20 donation to the local animal shelter. A receipt is attached for your records. |
| N103 | held | subscriptions | text |  | Your magazine subscription renews on 15 December at $34. Manage or cancel any time in your account. |
| N104 | dev | subscriptions | text | hard | Your annual donation reminder: you have supported us each year since 2019. If you would like to give again, you can do so on our website or by post. Thank you! |
| N105 | held | subscriptions | spoken |  | The animal shelter rang to thank me for last year's donation and asked if I would like their newsletter. |
| N106 | dev | subscriptions | spoken |  | I got a letter from the magazine saying the price is going up a little next year. |
| N107 | held | genuine_payment | spoken | legitpay | I am just popping to the post office to pay my electricity bill, the one that came in the post. |
| N108 | dev | genuine_payment | spoken | legitpay | I am about to pay my council tax online through the council website, I typed the address in myself. |
| N109 | held | genuine_payment | spoken | legitpay | I am going to the shop now to buy a gift card for my granddaughter's birthday, she asked me for one. |
| N110 | dev | genuine_payment | spoken | legitpay | I am sending my son some money for his rent. He asked me on the phone and I rang him back on his usual number. |
| N111 | held | genuine_payment | spoken | legitpay | I am at the pharmacy paying for my prescription with my card. |
| N112 | dev | genuine_payment | spoken | legitpay | I am about to transfer the deposit for the holiday cottage. I booked it with the travel agent I have used for years. |
| N133 | dev | genuine_fraud_alert | text | hard | FRAUD ALERT: We have blocked a card payment of $640 made in another city. If this was not you, reply NO or call the number on the back of your card. If it was you, reply YES. We will never ask for your PIN, password or any code. |
| N134 | held | genuine_inspection | text | hard | Final reminder: your car inspection expires on Friday. Book your test online or call your garage. A fine may apply if you drive after it expires. |
| N135 | dev | genuine_disconnect | text | hard | Your broadband will be disconnected on 5 November unless the overdue balance of $52.10 is paid. Pay in your online account, by phone using the number on your bill, or at any post office. |
| N136 | held | genuine_declined | text | hard | Your pharmacy order cannot be sent because your card was declined. Please update your payment method in your account, or call us during opening hours. |
| N137 | dev | genuine_flu | text | hard | You are due your annual flu vaccination. Book online or call your surgery before 30 November. This message is free and we will never ask for payment. |
| N138 | held | genuine_jury | text | hard | Jury service reminder: you are summoned to attend on 12 November. If you cannot attend you must contact the court office in writing before that date. Details are in the letter we posted to you. |
| N139 | dev | genuine_renewal | text | hard | Your home insurance renews on 1 December at $412. If you wish to change or cancel, contact us before 24 November. No action is needed to continue your cover. |
| N140 | held | genuine_tax | text | hard | Your tax return is due on 31 January and penalties apply if it is late. Please use the official government website. We never send links by text. |
| N141 | dev | genuine_meter | text | hard | We will visit on Tuesday between 8 and 12 to replace your smart meter. Please be home. Our staff carry ID and you can check by calling the number on your bill. No payment is taken at the door. |
| N142 | held | genuine_code | text | hard | Your verification code is 482913. It expires in 10 minutes. Do not share this code with anyone. |
| N143 | dev | genuine_code | spoken | hard | I just got a text with a code from the bank because I was logging in to my online banking myself, and it says not to share it with anyone. |
| N144 | held | genuine_dentist | spoken | hard | The dentist's receptionist rang and said that if I do not confirm my appointment today they will have to give it away, and I did book it last week. |
| N145 | dev | genuine_secret | spoken | hard | My grandson phoned from his own number, he told me he failed his driving test and he is embarrassed and wants me not to tell his dad, he just wanted a chat. |
| N146 | held | genuine_family_money | spoken | hard | My daughter texted from her usual number asking me to put some money into her account for the deposit on her flat. I rang her straight away and she confirmed it. |
| N147 | dev | genuine_solicitor | spoken | hard | The solicitor wrote to say the sale of mama's flat completes on Friday and I need to sign the form at their office. They gave the office address and I know the firm from before. |
| N148 | held | genuine_final_notice | spoken | hard | The electricity company sent a final reminder in the post with a red stamp saying I owe forty pounds, and it matches the bill I have in my drawer. |
| N149 | dev | genuine_payment | spoken | legitpay | I am at the bank counter now paying in a cheque from my sister, the teller is helping me. |
| N150 | held | genuine_payment | spoken | legitpay | I am about to pay the plumber who fixed my tap this morning. He gave me an invoice and I know him from the village. |
| N151 | dev | genuine_payment | spoken | legitpay | I am on the council website that I typed in myself and I am about to pay for my parking permit with my card. |
| N152 | held | genuine_payment | spoken | legitpay | I am buying vouchers at the supermarket as a Christmas gift for my nephew, he asked for them last week. |
