# CrossChex Attendance Sync

CrossChex Cloud 출퇴근 기록을 매일 자동으로 CSV 파일로 변환하여 OneDrive에 업로드하는 스크립트입니다.

## 동작 방식

1. **CrossChex Cloud API**에서 전날(뉴욕 시간 기준) 출퇴근 펀치 기록을 조회
2. 직원별 + 날짜별로 그룹핑하여 Punch In / Punch Out / Actual time을 계산
3. CrossChex 데스크톱 앱 내보내기(`CurrentData_*.xls`)와 동일한 형식의 **CSV** 파일 생성
4. **Microsoft Graph API**를 통해 OneDrive 지정 폴더에 업로드

## 요구 사항

- Node.js v22.14.0 (`.nvmrc` 참고)

## 설치

```bash
npm install
```

## 환경 변수

프로젝트 루트에 `.env` 파일을 생성합니다. (`.env.example` 참고)

| 변수 | 설명 |
|---|---|
| `CROSSCHEX_BASE` | CrossChex Cloud API 엔드포인트 (예: `https://api.us.crosschexcloud.com`) |
| `CROSSCHEX_API_KEY` | CrossChex Cloud에서 발급받은 API Key |
| `CROSSCHEX_API_SECRET` | CrossChex Cloud에서 발급받은 API Secret |
| `MS_CLIENT_ID` | Azure AD 앱 등록 Client ID |
| `MS_REFRESH_TOKEN` | Microsoft OAuth2 Refresh Token |
| `ONEDRIVE_FOLDER` | OneDrive 업로드 대상 폴더명 (기본값: `CrossChex`) |

### CrossChex API Key 발급

1. [CrossChex Cloud](https://us.crosschexcloud.com/) 로그인
2. **System** > **API Management** 에서 API Key / Secret 생성

### Microsoft (OneDrive) 설정

1. [Azure Portal](https://portal.azure.com/) > **App registrations** 에서 앱 등록
2. Redirect URI: `https://login.microsoftonline.com/common/oauth2/nativeclient`
3. API permissions: `Files.ReadWrite`, `offline_access`
4. OAuth2 Authorization Code Flow로 초기 Refresh Token을 발급받아 `MS_REFRESH_TOKEN`에 설정

## 실행

```bash
node sync.mjs
```

실행하면 뉴욕 시간 기준 **전날** 출퇴근 데이터를 수집하여 `attendance.csv`를 생성하고, OneDrive `{ONEDRIVE_FOLDER}/attendance_YYYY-MM-DD.csv`로 업로드합니다.

## 자동화 (GitHub Actions)

매일 오전 2시에 자동 실행하려면 `.github/workflows/sync.yml`을 추가합니다:

```yaml
name: Sync Attendance
on:
  schedule:
    - cron: "0 7 * * *"   # UTC 07:00 = NY 02:00 (EST)
  workflow_dispatch:        # 수동 실행 지원

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - run: npm ci
      - run: node sync.mjs
        env:
          CROSSCHEX_BASE: ${{ secrets.CROSSCHEX_BASE }}
          CROSSCHEX_API_KEY: ${{ secrets.CROSSCHEX_API_KEY }}
          CROSSCHEX_API_SECRET: ${{ secrets.CROSSCHEX_API_SECRET }}
          MS_CLIENT_ID: ${{ secrets.MS_CLIENT_ID }}
          MS_REFRESH_TOKEN: ${{ secrets.MS_REFRESH_TOKEN }}
          ONEDRIVE_FOLDER: ${{ secrets.ONEDRIVE_FOLDER }}
```

GitHub repo **Settings > Secrets and variables > Actions**에 위 환경 변수들을 등록하세요.

## 출력 CSV 형식

| Name | Employee No. | Position | Department | Date | Punch In | Punch Out | Actual time | Exception |
|---|---|---|---|---|---|---|---|---|
| SUNG TAE KIM | 2 | | SoJo Spa Engineering | 2026-02-19 | 06:35 | 17:09 | 10:33 | |
| CHRIS JANG | 17 | | SoJo Spa BMS | 2026-02-19 | 21:40 | | 00:00 | 1 |

- **Punch In**: 당일 첫 번째 펀치 시각 (NY 시간)
- **Punch Out**: 당일 마지막 펀치 시각 (NY 시간)
- **Actual time**: Punch Out - Punch In 시간
- **Exception**: Punch Out이 없으면 `1`
